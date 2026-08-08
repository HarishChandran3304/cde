(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	const connectButton = document.getElementById('connect');
	const directButton = document.getElementById('direct');
	const settingsButton = document.getElementById('settings');
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
	let assistantBuffer = '';
	let userBuffer = '';
	const pendingSdp = new Map();
	const handledCalls = new Set();

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
		assistantText.textContent = 'Opening a Realtime session.';

		try {
			peerConnection = new RTCPeerConnection();
			peerConnection.addEventListener('connectionstatechange', () => {
				log('webrtc.connection', peerConnection.connectionState);
				if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'disconnected') {
					setState('error', 'Connection lost');
				}
			});
			peerConnection.addEventListener('track', event => {
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
			peerConnection.addTrack(microphone.getAudioTracks()[0], microphone);

			dataChannel = peerConnection.createDataChannel('oai-events');
			dataChannel.addEventListener('open', () => {
				setState('listening', 'Listening');
				connectButton.disabled = false;
				connectButton.textContent = 'Disconnect';
				assistantText.textContent = 'Ask me to open the checkout logic.';
				log('realtime.ready');
			});
			dataChannel.addEventListener('message', event => handleRealtimeEvent(JSON.parse(event.data)));
			dataChannel.addEventListener('close', () => log('realtime.closed'));

			const offer = await peerConnection.createOffer();
			await peerConnection.setLocalDescription(offer);
			const requestId = nextId('sdp');
			const answerPromise = new Promise((resolve, reject) => pendingSdp.set(requestId, { resolve, reject }));
			vscode.postMessage({ type: 'exchangeSdp', requestId, sdp: offer.sdp });
			const answerSdp = await answerPromise;
			await peerConnection.setRemoteDescription({ type: 'answer', sdp: answerSdp });
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
		handledCalls.clear();
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

	function handleRealtimeEvent(event) {
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
				dispatchTool(event.call_id, event.name, event.arguments);
				break;
			case 'response.output_item.done':
				if (event.item?.type === 'function_call') {
					dispatchTool(event.item.call_id, event.item.name, event.item.arguments);
				}
				break;
			case 'response.done':
				if (!assistantBuffer) {
					setState('listening', 'Listening');
				}
				break;
			case 'error':
				assistantText.textContent = event.error?.message || 'Realtime returned an error.';
				setState('error', 'Realtime error');
				break;
		}
	}

	function dispatchTool(callId, name, args) {
		if (!callId || handledCalls.has(callId)) {
			return;
		}
		handledCalls.add(callId);
		const requestId = nextId('tool');
		setState('acting', 'Opening checkout…');
		assistantText.textContent = `Calling ${name}.`;
		log('tool.dispatch', `${name} ${args || '{}'}`);
		vscode.postMessage({
			type: 'executeTool',
			requestId,
			callId,
			name,
			arguments: args || '{}',
		});
	}

	function handleToolResult(message) {
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
	settingsButton.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
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
