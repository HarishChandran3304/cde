(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	const connectButton = document.getElementById('connect');
	const directButton = document.getElementById('direct');
	const textForm = document.getElementById('textForm');
	const textInput = document.getElementById('textInput');
	const stateText = document.getElementById('state');
	const orb = document.getElementById('orb');
	const userText = document.getElementById('userText');
	const assistantText = document.getElementById('assistantText');
	const events = document.getElementById('events');
	const remoteAudio = document.getElementById('remoteAudio');

	let peerConnection;
	let dataChannel;
	let microphone;
	let sequence = 0;
	let sessionEpochSequence = 0;
	let activeSessionEpoch;
	let assistantBuffer = '';
	let userBuffer = '';
	let awaitingToolFollowup = false;
	const pendingSdp = new Map();
	const handledCalls = new Set();
	const pendingTools = new Map();

	function nextId(prefix) {
		sequence += 1;
		return `${prefix}-${Date.now()}-${sequence}`;
	}

	function log(label, detail) {
		const time = new Date().toLocaleTimeString();
		const line = `${time}  ${label}${detail ? `  ${detail}` : ''}`;
		const current = events.textContent ? events.textContent.split('\n') : [];
		current.push(line);
		events.textContent = current.slice(-24).join('\n');
		events.scrollTop = events.scrollHeight;
	}

	function setState(state, label) {
		stateText.textContent = label;
		orb.className = `orb ${state}`;
		log(`state.${state}`);
	}

	function sendEvent(event) {
		if (!dataChannel || dataChannel.readyState !== 'open') {
			throw new Error('Realtime data channel is not open.');
		}
		dataChannel.send(JSON.stringify(event));
	}

	async function connect() {
		if (peerConnection) {
			disconnect();
			return;
		}

		connectButton.disabled = true;
		setState('connecting', 'Connecting…');
		assistantText.textContent = 'Starting the conversational IDE.';

		try {
			const sessionEpoch = ++sessionEpochSequence;
			activeSessionEpoch = sessionEpoch;
			const connection = new RTCPeerConnection();
			peerConnection = connection;
			connection.addEventListener('connectionstatechange', () => {
				if (activeSessionEpoch !== sessionEpoch || peerConnection !== connection) {
					return;
				}
				log('webrtc.connection', connection.connectionState);
				if (connection.connectionState === 'failed' || connection.connectionState === 'disconnected') {
					setState('error', 'Connection lost');
				}
			});
			connection.addEventListener('track', event => {
				if (activeSessionEpoch !== sessionEpoch || peerConnection !== connection) {
					return;
				}
				remoteAudio.srcObject = event.streams[0];
				void remoteAudio.play().catch(error => log('audio.play.error', error.message));
			});

			microphone = await navigator.mediaDevices.getUserMedia({
				audio: {
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true,
				},
			});
			connection.addTrack(microphone.getAudioTracks()[0], microphone);

			const channel = connection.createDataChannel('oai-events');
			dataChannel = channel;
			channel.addEventListener('open', () => {
				if (activeSessionEpoch !== sessionEpoch || dataChannel !== channel) {
					return;
				}
				setState('listening', 'Listening');
				connectButton.disabled = false;
				connectButton.textContent = 'Disconnect';
				assistantText.textContent = 'Ask me to navigate the workspace.';
				log('realtime.ready');
			});
			channel.addEventListener('message', event => {
				if (activeSessionEpoch === sessionEpoch && dataChannel === channel) {
					handleRealtimeEvent(JSON.parse(event.data), sessionEpoch);
				}
			});
			channel.addEventListener('close', () => log('realtime.closed'));

			const offer = await connection.createOffer();
			await connection.setLocalDescription(offer);
			const requestId = nextId('sdp');
			const answerPromise = new Promise((resolve, reject) => pendingSdp.set(requestId, { resolve, reject }));
			vscode.postMessage({ type: 'exchangeSdp', requestId, sdp: offer.sdp });
			const answerSdp = await answerPromise;
			if (activeSessionEpoch !== sessionEpoch || peerConnection !== connection) {
				return;
			}
			await connection.setRemoteDescription({ type: 'answer', sdp: answerSdp });
		} catch (error) {
			log('connect.error', error.message);
			assistantText.textContent = error.message;
			setState('error', 'Could not connect');
			disconnect(false);
			connectButton.disabled = false;
		}
	}

	function disconnect(updateCopy = true) {
		microphone?.getTracks().forEach(track => track.stop());
		dataChannel?.close();
		peerConnection?.close();
		microphone = undefined;
		dataChannel = undefined;
		peerConnection = undefined;
		activeSessionEpoch = undefined;
		awaitingToolFollowup = false;
		handledCalls.clear();
		pendingTools.clear();
		for (const pending of pendingSdp.values()) {
			pending.reject(new Error('Connection cancelled.'));
		}
		pendingSdp.clear();
		connectButton.textContent = 'Connect';
		connectButton.disabled = false;
		if (updateCopy) {
			setState('idle', 'Disconnected');
			assistantText.textContent = 'Waiting to connect.';
		}
	}

	function handleRealtimeEvent(event, sessionEpoch) {
		log(event.type);
		switch (event.type) {
			case 'input_audio_buffer.speech_started':
				userBuffer = '';
				setState('listening', 'Listening');
				break;
			case 'input_audio_buffer.speech_stopped':
				setState('thinking', 'Understanding…');
				break;
			case 'conversation.item.input_audio_transcription.delta':
				userBuffer += event.delta || '';
				userText.textContent = userBuffer;
				break;
			case 'conversation.item.input_audio_transcription.completed':
				userBuffer = event.transcript || userBuffer;
				userText.textContent = userBuffer;
				break;
			case 'response.created':
				assistantBuffer = '';
				setState('thinking', 'Thinking…');
				break;
			case 'response.output_audio_transcript.delta':
			case 'response.audio_transcript.delta':
			case 'response.output_text.delta':
				assistantBuffer += event.delta || '';
				assistantText.textContent = assistantBuffer;
				setState('speaking', 'Speaking');
				break;
			case 'response.function_call_arguments.done':
				dispatchTool(event.call_id, event.name, event.arguments, sessionEpoch);
				break;
			case 'response.output_item.done':
				if (event.item?.type === 'function_call') {
					dispatchTool(event.item.call_id, event.item.name, event.item.arguments, sessionEpoch);
				}
				break;
			case 'response.done': {
				const calledTool = event.response?.output?.some(item => item.type === 'function_call');
				if (pendingTools.size > 0) {
					setState('acting', 'Using the IDE…');
				} else if (!calledTool || !awaitingToolFollowup) {
					awaitingToolFollowup = false;
					setState('listening', 'Listening');
				}
				break;
			}
			case 'error':
				assistantText.textContent = event.error?.message || 'Realtime returned an error.';
				setState('error', 'Realtime error');
				break;
		}
	}

	function dispatchTool(callId, name, args, sessionEpoch) {
		if (activeSessionEpoch !== sessionEpoch || !callId || handledCalls.has(callId)) {
			return;
		}
		handledCalls.add(callId);
		pendingTools.set(callId, sessionEpoch);
		const requestId = nextId('tool');
		setState('acting', 'Using the IDE…');
		assistantText.textContent = 'Working in the editor…';
		log('tool.dispatch', `${name} ${args || '{}'}`);
		vscode.postMessage({
			type: 'executeTool',
			requestId,
			sessionEpoch,
			callId,
			name,
			arguments: args || '{}',
		});
	}

	function handleToolResult(message) {
		if (message.sessionEpoch !== activeSessionEpoch || pendingTools.get(message.callId) !== message.sessionEpoch) {
			log('tool.result.stale', message.callId || 'unknown call');
			return;
		}
		pendingTools.delete(message.callId);
		awaitingToolFollowup = true;
		log('tool.result', JSON.stringify(message.result));
		assistantText.textContent = message.result.spoken_response;
		sendEvent({
			type: 'conversation.item.create',
			item: {
				type: 'function_call_output',
				call_id: message.callId,
				output: JSON.stringify(message.result),
			},
		});
		sendEvent({
			type: 'response.create',
			response: {
				instructions: `Say exactly this and nothing else: ${message.result.spoken_response}`,
				tool_choice: 'none',
			},
		});
	}

	window.addEventListener('message', event => {
		const message = event.data;
		switch (message.type) {
			case 'sdpAnswer': {
				const pending = pendingSdp.get(message.requestId);
				pendingSdp.delete(message.requestId);
				pending?.resolve(message.sdp);
				break;
			}
			case 'requestError': {
				const pending = pendingSdp.get(message.requestId);
				pendingSdp.delete(message.requestId);
				pending?.reject(new Error(message.message));
				break;
			}
			case 'toolResult':
				handleToolResult(message);
				break;
			case 'directResult':
				assistantText.textContent = message.result.spoken_response;
				log('direct.result', JSON.stringify(message.result));
				break;
		}
	});

	connectButton.addEventListener('click', () => void connect());
	directButton.addEventListener('click', () => {
		const requestId = nextId('direct');
		log('direct.request');
		vscode.postMessage({ type: 'openCheckoutDirectly', requestId });
	});
	textForm.addEventListener('submit', event => {
		event.preventDefault();
		const text = textInput.value.trim();
		if (!text) {
			return;
		}
		try {
			userText.textContent = text;
			sendEvent({
				type: 'conversation.item.create',
				item: {
					type: 'message',
					role: 'user',
					content: [{ type: 'input_text', text }],
				},
			});
			sendEvent({ type: 'response.create' });
			textInput.value = '';
		} catch (error) {
			assistantText.textContent = error.message;
			log('text.error', error.message);
		}
	});
}());
