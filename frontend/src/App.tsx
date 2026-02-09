import { useEffect, useState, useRef, useCallback } from 'react';

// ============================================================================
// TYPES & CONSTANTS
// ============================================================================

// Message types (must match backend)
enum MessageType {
    // Room management
    CREATE_ROOM = 'CREATE_ROOM',
    JOIN_ROOM = 'JOIN_ROOM',
    ROOM_CREATED = 'ROOM_CREATED',
    ROOM_JOINED = 'ROOM_JOINED',
    PEER_JOINED = 'PEER_JOINED',
    PEER_DISCONNECTED = 'PEER_DISCONNECTED',
    ERROR = 'ERROR',

    // WebRTC signaling
    RTC_OFFER = 'RTC_OFFER',
    RTC_ANSWER = 'RTC_ANSWER',
    ICE_CANDIDATE = 'ICE_CANDIDATE'
}

// Explicit app states
enum AppState {
    IDLE = 'IDLE',
    ROOM_CREATED = 'ROOM_CREATED',
    ROOM_JOINING = 'ROOM_JOINING',
    CONNECTED = 'CONNECTED',
    ERROR = 'ERROR'
}

// User roles
type UserRole = 'sender' | 'receiver' | null;

// File Metadata
interface FileMeta {
    type: 'FILE_META';
    name: string;
    size: number;
    mimeType: string;
}

// Friendly error messages
const ERROR_MESSAGES: Record<string, string> = {
    'Room not found': 'Room not found. Please check the code and try again.',
    'Room is full': 'Room already has a connected device.',
    'Connection lost': 'Connection lost. Please try again.',
    'default': 'Something went wrong. Please try again.'
};

const getFriendlyError = (message: string): string => {
    return ERROR_MESSAGES[message] || ERROR_MESSAGES['default'];
};

// WebRTC configuration (STUN servers for NAT traversal)
const RTC_CONFIG: RTCConfiguration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

const DATA_CHANNEL_NAME = 'fusion-share';

// ============================================================================
// COMPONENT
// ============================================================================

function App() {
    // Core state
    const [appState, setAppState] = useState<AppState>(AppState.IDLE);
    const [roomId, setRoomId] = useState<string | null>(null);
    const [userRole, setUserRole] = useState<UserRole>(null);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    // UI state
    const [isConnected, setIsConnected] = useState(false);
    const [showJoinInput, setShowJoinInput] = useState(false);
    const [joinCode, setJoinCode] = useState('');
    const [statusMessage, setStatusMessage] = useState<string>('');

    // WebRTC state
    const [isWebRTCConnected, setIsWebRTCConnected] = useState(false);

    // Refs
    const wsRef = useRef<WebSocket | null>(null);
    const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
    const dataChannelRef = useRef<RTCDataChannel | null>(null);
    const mountedRef = useRef(false);
    const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
    const incomingFileMetaRef = useRef<FileMeta | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    // ============================================================================
    // WEBSOCKET SEND HELPER
    // ============================================================================

    const sendWsMessage = useCallback((type: MessageType | string, payload: Record<string, unknown> = {}) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type, ...payload }));
        }
    }, []);

    // ============================================================================
    // FILE TRANSFER LOGIC
    // ============================================================================

    const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file || !dataChannelRef.current || dataChannelRef.current.readyState !== 'open') return;

        setStatusMessage(`Sending ${file.name}...`);

        try {
            // 1. Send Metadata
            const meta: FileMeta = {
                type: 'FILE_META',
                name: file.name,
                size: file.size,
                mimeType: file.type
            };

            console.log('[FileTransfer] Sending metadata:', meta);
            dataChannelRef.current.send(JSON.stringify(meta));

            // 2. Read and Send File Content
            const buffer = await file.arrayBuffer();
            console.log(`[FileTransfer] Sending ${buffer.byteLength} bytes`);
            dataChannelRef.current.send(buffer);

            setStatusMessage(`Sent ${file.name} successfully!`);
            console.log('[FileTransfer] File sent successfully');

            // Reset input
            if (fileInputRef.current) fileInputRef.current.value = '';

        } catch (error) {
            console.error('[FileTransfer] Error sending file:', error);
            setStatusMessage('Error sending file');
            setErrorMessage('Failed to send file. Please try again.');
        }
    };

    const handleIncomingData = useCallback((data: string | ArrayBuffer) => {
        // Handle Metadata (JSON string)
        if (typeof data === 'string') {
            try {
                const message = JSON.parse(data);
                if (message.type === 'FILE_META') {
                    console.log('[FileTransfer] Received metadata:', message);
                    incomingFileMetaRef.current = message;
                    setStatusMessage(`Receiving ${message.name}...`);
                }
            } catch (e) {
                // Ignore non-JSON text messages (like hello messages)
                console.log(`[WebRTC] Text message: "${data}"`);
            }
            return;
        }

        // Handle File Content (ArrayBuffer)
        if (data instanceof ArrayBuffer) {
            const meta = incomingFileMetaRef.current;
            if (!meta) {
                console.error('[FileTransfer] Received data without metadata');
                return;
            }

            console.log(`[FileTransfer] Received ${data.byteLength} bytes`);

            // Create Blob and trigger download
            const blob = new Blob([data], { type: meta.mimeType });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = meta.name;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            setStatusMessage(`Received ${meta.name} successfully!`);
            console.log('[FileTransfer] File saved');

            // Reset metadata
            incomingFileMetaRef.current = null;
        }
    }, []);

    // ============================================================================
    // WEBRTC SETUP
    // ============================================================================

    const cleanupWebRTC = useCallback(() => {
        console.log('[WebRTC] Cleaning up...');

        if (dataChannelRef.current) {
            dataChannelRef.current.close();
            dataChannelRef.current = null;
        }

        if (peerConnectionRef.current) {
            peerConnectionRef.current.close();
            peerConnectionRef.current = null;
        }

        pendingCandidatesRef.current = [];
        incomingFileMetaRef.current = null;
        setIsWebRTCConnected(false);
        setStatusMessage('');
    }, []);

    const setupDataChannel = useCallback((channel: RTCDataChannel, role: 'sender' | 'receiver') => {
        console.log(`[WebRTC] Setting up DataChannel as ${role}`);
        dataChannelRef.current = channel;
        channel.binaryType = 'arraybuffer'; // Critical for file transfer

        channel.onopen = () => {
            console.log('[WebRTC] DataChannel opened');
            setIsWebRTCConnected(true);
            setStatusMessage('Ready to transfer files');
        };

        channel.onmessage = (event) => {
            handleIncomingData(event.data);
        };

        channel.onclose = () => {
            console.log('[WebRTC] DataChannel closed');
            setIsWebRTCConnected(false);
            setStatusMessage('');
        };

        channel.onerror = (error) => {
            console.error('[WebRTC] DataChannel error:', error);
            setErrorMessage('Data channel error');
        };
    }, [handleIncomingData]);

    const createPeerConnection = useCallback((role: 'sender' | 'receiver') => {
        console.log(`[WebRTC] Creating PeerConnection as ${role}`);

        const pc = new RTCPeerConnection(RTC_CONFIG);
        peerConnectionRef.current = pc;

        // ICE candidate handling
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('[WebRTC] ICE candidate generated, sending...');
                sendWsMessage(MessageType.ICE_CANDIDATE, {
                    candidate: event.candidate.toJSON()
                });
            }
        };

        pc.oniceconnectionstatechange = () => {
            console.log(`[WebRTC] ICE connection state: ${pc.iceConnectionState}`);
        };

        pc.onconnectionstatechange = () => {
            console.log(`[WebRTC] Connection state: ${pc.connectionState}`);
        };

        // Receiver listens for incoming data channel
        if (role === 'receiver') {
            pc.ondatachannel = (event) => {
                console.log('[WebRTC] Received DataChannel from sender');
                setupDataChannel(event.channel, 'receiver');
            };
        }

        return pc;
    }, [sendWsMessage, setupDataChannel]);

    const initiateSenderConnection = useCallback(async () => {
        console.log('[WebRTC] Sender initiating connection...');

        const pc = createPeerConnection('sender');

        // Create data channel
        const channel = pc.createDataChannel(DATA_CHANNEL_NAME);
        setupDataChannel(channel, 'sender');

        // Create and send offer
        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            console.log('[WebRTC] Offer created, sending via WebSocket...');
            sendWsMessage(MessageType.RTC_OFFER, { sdp: offer });
        } catch (error) {
            console.error('[WebRTC] Failed to create offer:', error);
        }
    }, [createPeerConnection, setupDataChannel, sendWsMessage]);

    const handleRTCOffer = useCallback(async (sdp: RTCSessionDescriptionInit) => {
        console.log('[WebRTC] Received offer, creating answer...');

        const pc = createPeerConnection('receiver');

        try {
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));

            // Add any pending ICE candidates
            for (const candidate of pendingCandidatesRef.current) {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            }
            pendingCandidatesRef.current = [];

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            console.log('[WebRTC] Answer created, sending via WebSocket...');
            sendWsMessage(MessageType.RTC_ANSWER, { sdp: answer });
        } catch (error) {
            console.error('[WebRTC] Failed to handle offer:', error);
        }
    }, [createPeerConnection, sendWsMessage]);

    const handleRTCAnswer = useCallback(async (sdp: RTCSessionDescriptionInit) => {
        console.log('[WebRTC] Received answer, setting remote description...');

        const pc = peerConnectionRef.current;
        if (!pc) {
            console.error('[WebRTC] No peer connection for answer');
            return;
        }

        try {
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));

            // Add any pending ICE candidates
            for (const candidate of pendingCandidatesRef.current) {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            }
            pendingCandidatesRef.current = [];

            console.log('[WebRTC] Remote description set successfully');
        } catch (error) {
            console.error('[WebRTC] Failed to set remote description:', error);
        }
    }, []);

    const handleICECandidate = useCallback(async (candidate: RTCIceCandidateInit) => {
        console.log('[WebRTC] Received ICE candidate');

        const pc = peerConnectionRef.current;
        if (!pc || !pc.remoteDescription) {
            // Queue candidate if we don't have remote description yet
            console.log('[WebRTC] Queuing ICE candidate (no remote description yet)');
            pendingCandidatesRef.current.push(candidate);
            return;
        }

        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
            console.log('[WebRTC] ICE candidate added');
        } catch (error) {
            console.error('[WebRTC] Failed to add ICE candidate:', error);
        }
    }, []);

    // ============================================================================
    // WEBSOCKET MESSAGE HANDLER
    // ============================================================================

    const handleMessage = useCallback((event: MessageEvent) => {
        try {
            const message = JSON.parse(event.data);
            console.log('Received:', message.type);

            switch (message.type) {
                case MessageType.ROOM_CREATED:
                    setRoomId(message.roomId);
                    setAppState(AppState.ROOM_CREATED);
                    setUserRole('sender');
                    setErrorMessage(null);
                    break;

                case MessageType.ROOM_JOINED:
                    setRoomId(message.roomId);
                    setAppState(AppState.CONNECTED);
                    setUserRole('receiver');
                    setErrorMessage(null);
                    setShowJoinInput(false);
                    setJoinCode('');
                    // Receiver waits for offer from sender
                    break;

                case MessageType.PEER_JOINED:
                    setAppState(AppState.CONNECTED);
                    setErrorMessage(null);
                    // Sender initiates WebRTC connection when peer joins
                    initiateSenderConnection();
                    break;

                case MessageType.PEER_DISCONNECTED:
                    cleanupWebRTC();
                    setUserRole((currentRole) => {
                        if (currentRole === 'sender') {
                            setAppState(AppState.ROOM_CREATED);
                        } else {
                            setAppState(AppState.ERROR);
                            setRoomId(null);
                            setErrorMessage('Connection lost. Please try again.');
                            setTimeout(() => setAppState(AppState.IDLE), 100);
                        }
                        return currentRole === 'sender' ? 'sender' : null;
                    });
                    break;

                case MessageType.ERROR:
                    setErrorMessage(getFriendlyError(message.message));
                    setAppState((current) => {
                        if (current === AppState.ROOM_JOINING) {
                            return AppState.IDLE;
                        }
                        return current;
                    });
                    break;

                // WebRTC signaling
                case MessageType.RTC_OFFER:
                    handleRTCOffer(message.sdp);
                    break;

                case MessageType.RTC_ANSWER:
                    handleRTCAnswer(message.sdp);
                    break;

                case MessageType.ICE_CANDIDATE:
                    handleICECandidate(message.candidate);
                    break;

                default:
                    console.log('Unknown message type:', message.type);
            }
        } catch (error) {
            console.error('Failed to parse message:', error);
        }
    }, [initiateSenderConnection, cleanupWebRTC, handleRTCOffer, handleRTCAnswer, handleICECandidate]);

    // ============================================================================
    // WEBSOCKET CONNECTION
    // ============================================================================

    const connectWebSocket = useCallback(() => {
        const ws = new WebSocket('ws://localhost:8080');
        wsRef.current = ws;

        ws.onopen = () => {
            console.log('Connected to server');
            setIsConnected(true);
            setErrorMessage(null);
        };

        ws.onclose = () => {
            console.log('Disconnected from server');
            setIsConnected(false);
        };

        ws.onmessage = handleMessage;

        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            setErrorMessage('Connection lost. Please try again.');
        };

        return ws;
    }, [handleMessage]);

    useEffect(() => {
        if (mountedRef.current) return;
        mountedRef.current = true;

        connectWebSocket();

        return () => {
            mountedRef.current = false;
            cleanupWebRTC();
            wsRef.current?.close();
        };
    }, [connectWebSocket, cleanupWebRTC]);

    // ============================================================================
    // ACTIONS
    // ============================================================================

    const handleCreateRoom = () => {
        if (appState !== AppState.IDLE || !isConnected) return;
        setErrorMessage(null);
        sendWsMessage(MessageType.CREATE_ROOM);
    };

    const handleJoinRoom = () => {
        if (appState !== AppState.IDLE || !isConnected) return;
        setShowJoinInput(true);
        setErrorMessage(null);
    };

    const handleJoinSubmit = () => {
        const code = joinCode.trim().toUpperCase();
        if (!code) {
            setErrorMessage('Please enter a room code');
            return;
        }
        if (code.length !== 4) {
            setErrorMessage('Room code must be 4 characters');
            return;
        }
        setAppState(AppState.ROOM_JOINING);
        setErrorMessage(null);
        sendWsMessage(MessageType.JOIN_ROOM, { roomId: code });
    };

    const handleCancelJoin = () => {
        setShowJoinInput(false);
        setJoinCode('');
        setErrorMessage(null);
    };

    const handleLeaveRoom = () => {
        cleanupWebRTC();

        if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
        }

        // Reset inputs
        if (fileInputRef.current) fileInputRef.current.value = '';

        setAppState(AppState.IDLE);
        setRoomId(null);
        setUserRole(null);
        setErrorMessage(null);
        setShowJoinInput(false);
        setJoinCode('');

        setTimeout(() => {
            connectWebSocket();
        }, 100);
    };

    // ============================================================================
    // STATUS TEXT
    // ============================================================================

    const getStatusText = (): string => {
        if (statusMessage) return statusMessage;

        if (appState === AppState.CONNECTED && isWebRTCConnected) {
            return userRole === 'sender' ? 'Ready to send files' : 'Ready to receive files';
        }

        switch (appState) {
            case AppState.ROOM_CREATED:
                return 'Waiting for another device to join...';
            case AppState.ROOM_JOINING:
                return 'Joining room...';
            case AppState.CONNECTED:
                return 'Establishing peer-to-peer connection...';
            default:
                return '';
        }
    };

    // ============================================================================
    // RENDER HELPERS
    // ============================================================================

    const renderRoleBadge = () => {
        if (!userRole) return null;
        return (
            <div className="role-badge">
                {userRole === 'sender' ? '📤 Sender' : '📥 Receiver'}
            </div>
        );
    };

    const renderWebRTCStatus = () => {
        if (appState !== AppState.CONNECTED) return null;

        return (
            <div className="webrtc-status">
                <span className={`status-dot ${isWebRTCConnected ? 'connected' : 'disconnected'}`} />
                <span>{isWebRTCConnected ? 'WebRTC connected' : 'Connecting...'}</span>
            </div>
        );
    };

    const renderFileTransferUI = () => {
        if (userRole !== 'sender' || !isWebRTCConnected) return null;

        return (
            <div className="file-transfer-ui">
                <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileSelect}
                    className="file-input"
                    disabled={!isWebRTCConnected}
                    accept="image/*,application/pdf,text/plain"
                />
                <button
                    className="btn btn-primary"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={!isWebRTCConnected}
                >
                    Select File to Send
                </button>
                <p className="file-hint">Max size: 5MB</p>
            </div>
        );
    };

    const renderRoomView = () => (
        <div className="room-info">
            <div className="room-code-container">
                <span className="room-code-label">Room Code</span>
                <span className="room-code">{roomId}</span>
            </div>

            {renderRoleBadge()}

            <p className="room-status">{getStatusText()}</p>

            {renderFileTransferUI()}

            {renderWebRTCStatus()}

            <button
                className="btn btn-secondary"
                onClick={handleLeaveRoom}
            >
                Leave Room
            </button>
        </div>
    );

    const renderJoinForm = () => (
        <div className="join-form">
            <input
                type="text"
                className="join-input"
                placeholder="XXXX"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && handleJoinSubmit()}
                maxLength={4}
                autoFocus
                disabled={appState === AppState.ROOM_JOINING}
            />
            <div className="join-actions">
                <button
                    className="btn btn-primary"
                    onClick={handleJoinSubmit}
                    disabled={!joinCode.trim() || appState === AppState.ROOM_JOINING}
                >
                    {appState === AppState.ROOM_JOINING ? 'Joining...' : 'Join'}
                </button>
                <button
                    className="btn btn-secondary"
                    onClick={handleCancelJoin}
                    disabled={appState === AppState.ROOM_JOINING}
                >
                    Cancel
                </button>
            </div>
        </div>
    );

    const renderIdleView = () => {
        if (showJoinInput) {
            return renderJoinForm();
        }

        return (
            <div className="actions">
                <button
                    className="btn btn-primary"
                    onClick={handleCreateRoom}
                    disabled={!isConnected}
                >
                    Create Room
                </button>
                <button
                    className="btn btn-secondary"
                    onClick={handleJoinRoom}
                    disabled={!isConnected}
                >
                    Join Room
                </button>
            </div>
        );
    };

    const renderContent = () => {
        switch (appState) {
            case AppState.ROOM_CREATED:
            case AppState.CONNECTED:
                return renderRoomView();
            case AppState.ROOM_JOINING:
                return renderJoinForm();
            case AppState.IDLE:
            case AppState.ERROR:
            default:
                return renderIdleView();
        }
    };

    // ============================================================================
    // MAIN RENDER
    // ============================================================================

    return (
        <div className="container">
            <header className="header">
                <h1 className="title">Fusion Share</h1>
                <p className="subtitle">Cross-device file sharing</p>
            </header>

            <div className="status">
                <span className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`} />
                <span className="status-text">
                    {isConnected ? 'Connected' : 'Connecting...'}
                </span>
            </div>

            {errorMessage && (
                <div className="error-message" role="alert">
                    {errorMessage}
                </div>
            )}

            <main className="main-content">
                {renderContent()}
            </main>

            <footer className="footer">
                <p>Works on Android, iOS & Desktop</p>
            </footer>
        </div>
    );
}

export default App;
