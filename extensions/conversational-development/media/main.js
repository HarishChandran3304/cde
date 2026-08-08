(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	const connectButton = document.getElementById('connect');
	const muteButton = document.getElementById('mute');
	const directButton = document.getElementById('direct');
	const textForm = document.getElementById('textForm');
	const textInput = document.getElementById('textInput');
	const stateText = document.getElementById('state');
	const orb = document.getElementById('orb');
	const userText = document.getElementById('userText');
	const assistantText = document.getElementById('assistantText');
	const events = document.getElementById('events');
	const remoteAudio = document.getElementById('remoteAudio');
	const walkthroughSection = document.getElementById('walkthrough');
	const walkthroughProgress = document.getElementById('walkthroughProgress');
	const walkthroughSteps = document.getElementById('walkthroughSteps');
	const walkthroughFollowButton = document.getElementById('walkthroughFollow');
	const walkthroughPreviousButton = document.getElementById('walkthroughPrevious');
	const walkthroughPauseButton = document.getElementById('walkthroughPause');
	const walkthroughRepeatButton = document.getElementById('walkthroughRepeat');
	const walkthroughNextButton = document.getElementById('walkthroughNext');
	const walkthroughStopButton = document.getElementById('walkthroughStop');

	let peerConnection;
	let dataChannel;
	let microphone;
	let microphoneMuted = false;
	let sequence = 0;
	let sessionEpochSequence = 0;
	let activeSessionEpoch;
	let assistantBuffer = '';
	let userBuffer = '';
	let pinnedToolAnswer = false;
	let awaitingToolFollowup = false;
	let activeWalkthrough;
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

	function setReadyState() {
		setState(microphoneMuted ? 'muted' : 'listening', microphoneMuted ? 'Muted' : 'Listening');
	}

	function setMicrophoneMuted(muted) {
		const audioTrack = microphone?.getAudioTracks()[0];
		if (!audioTrack) {
			return;
		}

		microphoneMuted = muted;
		audioTrack.enabled = !muted;
		muteButton.textContent = muted ? 'Unmute' : 'Mute';
		muteButton.title = muted ? 'Unmute microphone' : 'Mute microphone';
		muteButton.setAttribute('aria-pressed', String(muted));
		try {
			sendEvent({
				type: 'session.update',
				session: {
					type: 'realtime',
					audio: {
						input: {
							turn_detection: {
								type: 'semantic_vad',
								eagerness: 'high',
								create_response: true,
								interrupt_response: !muted,
							},
						},
					},
				},
			});
		} catch (error) {
			log('microphone.session-update.error', error.message);
		}
		setReadyState();
		log(muted ? 'microphone.muted' : 'microphone.unmuted');
	}

	function sendEvent(event) {
		if (!dataChannel || dataChannel.readyState !== 'open') {
			throw new Error('Realtime data channel is not open.');
		}
		dataChannel.send(JSON.stringify(event));
	}

	function sendFunctionCallOutput(callId, result) {
		sendEvent({
			type: 'conversation.item.create',
			item: {
				type: 'function_call_output',
				call_id: callId,
				output: JSON.stringify(result),
			},
		});
	}

	function sendExactToolFollowup(spokenResponse) {
		awaitingToolFollowup = true;
		sendEvent({
			type: 'response.create',
			response: {
				instructions: `Say exactly this and nothing else: ${spokenResponse}`,
				tool_choice: 'none',
			},
		});
	}

	function renderWalkthrough() {
		if (!activeWalkthrough) {
			walkthroughSection.hidden = true;
			walkthroughSteps.replaceChildren();
			return;
		}

		walkthroughSection.hidden = false;
		const currentNumber = activeWalkthrough.index + 1;
		walkthroughProgress.textContent = activeWalkthrough.completed
			? `Complete · ${activeWalkthrough.steps.length} steps`
			: activeWalkthrough.paused
				? `Paused · ${currentNumber} of ${activeWalkthrough.steps.length}`
				: `${currentNumber} of ${activeWalkthrough.steps.length}`;
		walkthroughFollowButton.textContent = activeWalkthrough.follow ? 'Follow On' : 'Follow Off';
		walkthroughFollowButton.setAttribute('aria-pressed', String(activeWalkthrough.follow));
		walkthroughPauseButton.textContent = activeWalkthrough.paused ? 'Resume' : 'Pause';
		walkthroughPreviousButton.disabled = activeWalkthrough.index <= 0;
		walkthroughNextButton.disabled = activeWalkthrough.index >= activeWalkthrough.steps.length - 1;
		walkthroughPauseButton.disabled = activeWalkthrough.completed;
		walkthroughRepeatButton.disabled = activeWalkthrough.index < 0;

		const items = activeWalkthrough.steps.map((step, index) => {
			const item = document.createElement('li');
			if (index === activeWalkthrough.index) {
				item.classList.add('current');
			} else if (index < activeWalkthrough.index || activeWalkthrough.completed) {
				item.classList.add('visited');
			}
			if (activeWalkthrough.failedSteps.has(index)) {
				item.classList.add('failed');
			}

			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'walkthrough-step';
			button.title = `Open ${step.path}:${step.start_line}`;
			button.addEventListener('click', () => goToWalkthroughStep(index, true));

			const marker = document.createElement('span');
			marker.className = 'walkthrough-marker';
			marker.textContent = String(index + 1);
			const copy = document.createElement('span');
			copy.className = 'walkthrough-step-copy';
			const title = document.createElement('strong');
			title.textContent = step.title;
			const location = document.createElement('small');
			location.textContent = `${step.path}:${step.start_line}`;
			copy.append(title, location);
			button.append(marker, copy);
			item.append(button);
			return item;
		});
		walkthroughSteps.replaceChildren(...items);
	}

	function cancelWalkthroughAudio() {
		if (!activeWalkthrough?.responseId) {
			return;
		}
		try {
			sendEvent({ type: 'response.cancel', response_id: activeWalkthrough.responseId });
			sendEvent({ type: 'output_audio_buffer.clear' });
		} catch (error) {
			log('walkthrough.cancel.error', error.message);
		}
		activeWalkthrough.responseId = undefined;
		activeWalkthrough.responseCompleted = false;
	}

	function clearWalkthrough(cancelAudio = true) {
		if (cancelAudio) {
			cancelWalkthroughAudio();
		}
		activeWalkthrough = undefined;
		walkthroughSection.hidden = true;
		walkthroughSteps.replaceChildren();
		vscode.postMessage({ type: 'resetWalkthrough' });
	}

	function pauseWalkthroughForInput() {
		if (!activeWalkthrough || activeWalkthrough.completed) {
			return;
		}
		activeWalkthrough.paused = true;
		activeWalkthrough.responseId = undefined;
		activeWalkthrough.responseCompleted = false;
		activeWalkthrough.narrationPending = false;
		renderWalkthrough();
	}

	function startWalkthrough(message) {
		clearWalkthrough();
		activeWalkthrough = {
			id: `${message.sessionEpoch}-${message.callId}`,
			steps: message.result.walkthrough,
			fallback: message.result.spoken_response,
			index: -1,
			follow: true,
			paused: false,
			completed: false,
			responseId: undefined,
			responseCompleted: false,
			narrationPending: false,
			pendingReveal: undefined,
			failedSteps: new Set(),
			narratedSteps: new Set(),
		};
		renderWalkthrough();
		goToWalkthroughStep(0);
	}

	function requestWalkthroughReveal(narrateAfterReveal) {
		if (!activeWalkthrough || activeWalkthrough.index < 0) {
			return;
		}
		const requestId = nextId('walkthrough');
		activeWalkthrough.pendingReveal = {
			requestId,
			stepIndex: activeWalkthrough.index,
			narrateAfterReveal,
		};
		setState('acting', 'Following the code…');
		vscode.postMessage({
			type: 'revealWalkthroughStep',
			requestId,
			sessionEpoch: activeSessionEpoch,
			walkthroughId: activeWalkthrough.id,
			stepIndex: activeWalkthrough.index,
			step: activeWalkthrough.steps[activeWalkthrough.index],
		});
	}

	function narrateCurrentWalkthroughStep() {
		if (!activeWalkthrough || activeWalkthrough.paused || activeWalkthrough.index < 0) {
			return;
		}
		const step = activeWalkthrough.steps[activeWalkthrough.index];
		activeWalkthrough.narrationPending = true;
		activeWalkthrough.responseCompleted = false;
		setState('thinking', 'Preparing walkthrough…');
		sendEvent({
			type: 'response.create',
			response: {
				conversation: 'none',
				metadata: {
					cde_kind: 'walkthrough',
					cde_walkthrough_id: activeWalkthrough.id,
					cde_step_index: String(activeWalkthrough.index),
				},
				input: [],
				output_modalities: ['audio'],
				instructions: `Say exactly this and nothing else: ${step.narration}`,
				tool_choice: 'none',
			},
		});
	}

	function goToWalkthroughStep(index, forceReveal = false) {
		if (!activeWalkthrough || index < 0 || index >= activeWalkthrough.steps.length) {
			return;
		}
		cancelWalkthroughAudio();
		activeWalkthrough.index = index;
		activeWalkthrough.paused = false;
		activeWalkthrough.completed = false;
		activeWalkthrough.narrationPending = false;
		activeWalkthrough.pendingReveal = undefined;
		renderWalkthrough();
		if (activeWalkthrough.follow || forceReveal) {
			requestWalkthroughReveal(true);
		} else {
			narrateCurrentWalkthroughStep();
		}
	}

	function finishWalkthrough() {
		if (!activeWalkthrough) {
			return;
		}
		activeWalkthrough.completed = true;
		activeWalkthrough.paused = false;
		activeWalkthrough.responseId = undefined;
		activeWalkthrough.responseCompleted = false;
		activeWalkthrough.narrationPending = false;
		awaitingToolFollowup = false;
		renderWalkthrough();
		setReadyState();
		log('walkthrough.complete', `${activeWalkthrough.narratedSteps.size}/${activeWalkthrough.steps.length} narrated`);
		if (activeWalkthrough.narratedSteps.size === 0 && activeWalkthrough.fallback) {
			sendEvent({
				type: 'response.create',
				response: {
					conversation: 'none',
					metadata: { cde_kind: 'walkthrough_fallback' },
					input: [],
					output_modalities: ['audio'],
					instructions: `Say exactly this and nothing else: ${activeWalkthrough.fallback}`,
					tool_choice: 'none',
				},
			});
		}
	}

	function handleWalkthroughStepReady(message) {
		const pendingReveal = activeWalkthrough?.pendingReveal;
		if (!activeWalkthrough
			|| message.sessionEpoch !== activeSessionEpoch
			|| message.walkthroughId !== activeWalkthrough.id
			|| message.stepIndex !== activeWalkthrough.index
			|| message.requestId !== pendingReveal?.requestId) {
			log('walkthrough.reveal.stale', message.walkthroughId || 'unknown walkthrough');
			return;
		}

		activeWalkthrough.pendingReveal = undefined;
		log('walkthrough.reveal', JSON.stringify(message.result));
		if (!message.result.ok) {
			activeWalkthrough.failedSteps.add(message.stepIndex);
			renderWalkthrough();
			if (pendingReveal.narrateAfterReveal && !activeWalkthrough.paused) {
				const nextIndex = message.stepIndex + 1;
				if (nextIndex < activeWalkthrough.steps.length) {
					goToWalkthroughStep(nextIndex);
				} else {
					finishWalkthrough();
				}
			}
			return;
		}

		if (pendingReveal.narrateAfterReveal && !activeWalkthrough.paused) {
			narrateCurrentWalkthroughStep();
		} else {
			setReadyState();
		}
	}

	function walkthroughMetadata(response) {
		const metadata = response?.metadata;
		if (metadata?.cde_kind !== 'walkthrough') {
			return undefined;
		}
		return {
			walkthroughId: metadata.cde_walkthrough_id,
			stepIndex: Number(metadata.cde_step_index),
		};
	}

	function isCurrentWalkthroughResponse(response) {
		const metadata = walkthroughMetadata(response);
		return Boolean(activeWalkthrough
			&& metadata
			&& metadata.walkthroughId === activeWalkthrough.id
			&& metadata.stepIndex === activeWalkthrough.index);
	}

	function handleWalkthroughControl(callId, serializedArguments) {
		let action;
		try {
			action = JSON.parse(serializedArguments || '{}').action;
		} catch {
			action = undefined;
		}
		const allowedActions = ['next', 'previous', 'repeat', 'pause', 'resume', 'stop', 'follow_on', 'follow_off'];
		if (!allowedActions.includes(action)) {
			const result = { ok: false, spoken_response: 'I could not understand that walkthrough command.' };
			sendFunctionCallOutput(callId, result);
			sendExactToolFollowup(result.spoken_response);
			return;
		}
		if (!activeWalkthrough) {
			const result = { ok: false, spoken_response: 'There is no active walkthrough.' };
			sendFunctionCallOutput(callId, result);
			sendExactToolFollowup(result.spoken_response);
			return;
		}

		const result = { ok: true, action, spoken_response: 'Updated the walkthrough.' };
		sendFunctionCallOutput(callId, result);
		pinnedToolAnswer = true;
		awaitingToolFollowup = true;
		switch (action) {
			case 'next':
				if (activeWalkthrough.index < activeWalkthrough.steps.length - 1) {
					goToWalkthroughStep(activeWalkthrough.index + 1);
				} else {
					finishWalkthrough();
					sendExactToolFollowup('That was the final walkthrough step.');
				}
				break;
			case 'previous':
				goToWalkthroughStep(Math.max(0, activeWalkthrough.index - 1));
				break;
			case 'repeat':
				goToWalkthroughStep(activeWalkthrough.index, true);
				break;
			case 'pause':
				cancelWalkthroughAudio();
				activeWalkthrough.paused = true;
				renderWalkthrough();
				setReadyState();
				sendExactToolFollowup('Paused the walkthrough.');
				break;
			case 'resume':
				goToWalkthroughStep(activeWalkthrough.index, true);
				break;
			case 'stop':
				cancelWalkthroughAudio();
				activeWalkthrough.completed = true;
				renderWalkthrough();
				vscode.postMessage({ type: 'resetWalkthrough' });
				setReadyState();
				sendExactToolFollowup('Stopped the walkthrough.');
				break;
			case 'follow_on':
				activeWalkthrough.follow = true;
				renderWalkthrough();
				requestWalkthroughReveal(false);
				sendExactToolFollowup('Editor following is on.');
				break;
			case 'follow_off':
				activeWalkthrough.follow = false;
				renderWalkthrough();
				sendExactToolFollowup('Editor following is off.');
				break;
		}
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
				setReadyState();
				connectButton.disabled = false;
				connectButton.textContent = 'Disconnect';
				muteButton.disabled = false;
				assistantText.textContent = 'Ask me to navigate or explain the workspace.';
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
		microphoneMuted = false;
		dataChannel = undefined;
		peerConnection = undefined;
		activeSessionEpoch = undefined;
		pinnedToolAnswer = false;
		awaitingToolFollowup = false;
		clearWalkthrough(false);
		handledCalls.clear();
		pendingTools.clear();
		for (const pending of pendingSdp.values()) {
			pending.reject(new Error('Connection cancelled.'));
		}
		pendingSdp.clear();
		connectButton.textContent = 'Connect';
		connectButton.disabled = false;
		muteButton.textContent = 'Mute';
		muteButton.title = 'Mute microphone';
		muteButton.setAttribute('aria-pressed', 'false');
		muteButton.disabled = true;
		if (updateCopy) {
			setState('idle', 'Disconnected');
			assistantText.textContent = 'Waiting to connect.';
		}
	}

	function handleRealtimeEvent(event, sessionEpoch) {
		log(event.type);
		switch (event.type) {
			case 'input_audio_buffer.speech_started':
				pinnedToolAnswer = false;
				pauseWalkthroughForInput();
				userBuffer = '';
				setReadyState();
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
			case 'response.created': {
				const metadata = walkthroughMetadata(event.response);
				if (metadata) {
					if (isCurrentWalkthroughResponse(event.response)) {
						activeWalkthrough.responseId = event.response.id;
						activeWalkthrough.responseCompleted = false;
						activeWalkthrough.narrationPending = false;
						setState('speaking', 'Walking through the code…');
					} else if (event.response?.id) {
						sendEvent({ type: 'response.cancel', response_id: event.response.id });
						sendEvent({ type: 'output_audio_buffer.clear' });
					}
					break;
				}
				assistantBuffer = '';
				setState('thinking', 'Thinking…');
				break;
			}
			case 'response.output_audio_transcript.delta':
			case 'response.audio_transcript.delta':
			case 'response.output_text.delta':
				assistantBuffer += event.delta || '';
				if (!pinnedToolAnswer) {
					assistantText.textContent = assistantBuffer;
				}
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
				const responseStatus = event.response?.status || 'unknown';
				const responseReason = event.response?.status_details?.reason;
				log('response.done.detail', `${responseStatus}${responseReason ? ` ${responseReason}` : ''}`);
				if (walkthroughMetadata(event.response)) {
					if (isCurrentWalkthroughResponse(event.response)
						&& event.response.id === activeWalkthrough.responseId) {
						activeWalkthrough.responseCompleted = responseStatus === 'completed';
						if (!activeWalkthrough.responseCompleted) {
							activeWalkthrough.responseId = undefined;
							if (!activeWalkthrough.paused) {
								setReadyState();
							}
						}
					}
					break;
				}
				const calledTool = event.response?.output?.some(item => item.type === 'function_call');
				if (pendingTools.size > 0) {
					setState('acting', 'Using the IDE…');
				} else if (!calledTool || !awaitingToolFollowup) {
					awaitingToolFollowup = false;
					setReadyState();
				}
				break;
			}
			case 'output_audio_buffer.stopped':
				if (activeWalkthrough
					&& event.response_id === activeWalkthrough.responseId
					&& activeWalkthrough.responseCompleted) {
					activeWalkthrough.narratedSteps.add(activeWalkthrough.index);
					activeWalkthrough.responseId = undefined;
					activeWalkthrough.responseCompleted = false;
					if (!activeWalkthrough.paused && activeWalkthrough.index < activeWalkthrough.steps.length - 1) {
						goToWalkthroughStep(activeWalkthrough.index + 1);
					} else if (!activeWalkthrough.paused) {
						finishWalkthrough();
					}
				}
				break;
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
		if (name === 'control_walkthrough') {
			setState('acting', 'Controlling the walkthrough…');
			log('tool.dispatch', `${name} ${args || '{}'}`);
			handleWalkthroughControl(callId, args);
			return;
		}
		if (activeWalkthrough) {
			clearWalkthrough();
		}
		pendingTools.set(callId, sessionEpoch);
		const requestId = nextId('tool');
		const isCodeQuestion = name === 'ask_codebase';
		setState('acting', isCodeQuestion ? 'Inspecting the codebase…' : 'Using the IDE…');
		assistantText.textContent = isCodeQuestion ? 'Reading the relevant code…' : 'Working in the editor…';
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
		pinnedToolAnswer = Boolean(message.result.display_response);
		assistantText.textContent = message.result.display_response || message.result.spoken_response;
		sendFunctionCallOutput(message.callId, message.result);
		if (message.result.ok && Array.isArray(message.result.walkthrough) && message.result.walkthrough.length > 0) {
			startWalkthrough(message);
		} else {
			sendExactToolFollowup(message.result.spoken_response);
		}
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
			case 'walkthroughStepReady':
				handleWalkthroughStepReady(message);
				break;
			case 'directResult':
				assistantText.textContent = message.result.spoken_response;
				log('direct.result', JSON.stringify(message.result));
				break;
		}
	});

	connectButton.addEventListener('click', () => void connect());
	muteButton.addEventListener('click', () => setMicrophoneMuted(!microphoneMuted));
	walkthroughFollowButton.addEventListener('click', () => {
		if (!activeWalkthrough) {
			return;
		}
		activeWalkthrough.follow = !activeWalkthrough.follow;
		renderWalkthrough();
		if (activeWalkthrough.follow && activeWalkthrough.index >= 0) {
			requestWalkthroughReveal(false);
		}
	});
	walkthroughPreviousButton.addEventListener('click', () => {
		if (activeWalkthrough) {
			goToWalkthroughStep(activeWalkthrough.index - 1, true);
		}
	});
	walkthroughPauseButton.addEventListener('click', () => {
		if (!activeWalkthrough) {
			return;
		}
		if (activeWalkthrough.paused) {
			goToWalkthroughStep(activeWalkthrough.index, true);
		} else {
			cancelWalkthroughAudio();
			activeWalkthrough.paused = true;
			renderWalkthrough();
			setReadyState();
		}
	});
	walkthroughRepeatButton.addEventListener('click', () => {
		if (activeWalkthrough) {
			goToWalkthroughStep(activeWalkthrough.index, true);
		}
	});
	walkthroughNextButton.addEventListener('click', () => {
		if (activeWalkthrough) {
			goToWalkthroughStep(activeWalkthrough.index + 1, true);
		}
	});
	walkthroughStopButton.addEventListener('click', () => {
		if (!activeWalkthrough) {
			return;
		}
		cancelWalkthroughAudio();
		activeWalkthrough.completed = true;
		activeWalkthrough.paused = false;
		awaitingToolFollowup = false;
		renderWalkthrough();
		vscode.postMessage({ type: 'resetWalkthrough' });
		setReadyState();
	});
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
			pinnedToolAnswer = false;
			pauseWalkthroughForInput();
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
