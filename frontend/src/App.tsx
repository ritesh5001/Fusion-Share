import { useEffect, useState, useRef, useCallback } from 'react';
import QRCode from 'qrcode';
import { Html5QrcodeScanner } from 'html5-qrcode';

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
    ERROR = 'ERROR',
    TRANSFERRING = 'TRANSFERRING'
}

// User roles
type UserRole = 'sender' | 'receiver' | null;

// File Metadata
interface FileMeta {
    type: 'FILE_META';
    fileId: string;
    name: string;
    size: number;
    mimeType: string;
    chunkSize: number;
    totalChunks: number;
}

// Chunk Message
interface ChunkMessage {
    type: 'FILE_CHUNK';
    fileId: string;
    index: number;
    data: string; // Base64 encoded
}

// Ack Message
interface AckMessage {
    type: 'CHUNK_ACK';
    fileId: string;
    index: number;
}

// Resume Request
interface ResumeRequest {
    type: 'RESUME_REQUEST';
    fileId: string;
    lastReceivedChunk: number;
}

// Transfer State
interface TransferState {
    fileId: string;
    fileName: string;
    fileSize: number;
    totalChunks: number;
    chunks: (string | ArrayBuffer | null)[]; // Allow null for memory clearing
    currentChunkIndex: number;
    startTime: number;
}

const CHUNK_SIZE = 16 * 1024; // 16KB safe chunk size
const DATA_CHANNEL_NAME = 'fusion-share';

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

// WebRTC configuration
const RTC_CONFIG: RTCConfiguration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// Helper to generate UUID
const generateId = () => Math.random().toString(36).substring(2, 15);

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
    const [progress, setProgress] = useState<number>(0);
    const [canResume, setCanResume] = useState(false);

    // QR Code state
    const [qrCodeUrl, setQrCodeUrl] = useState<string>('');
    const [showScanner, setShowScanner] = useState(false);

    // WebRTC state
    const [isWebRTCConnected, setIsWebRTCConnected] = useState(false);

    // Refs
    const wsRef = useRef<WebSocket | null>(null);
    const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
    const dataChannelRef = useRef<RTCDataChannel | null>(null);
    const mountedRef = useRef(false);
    const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
    const scannerRef = useRef<Html5QrcodeScanner | null>(null);

    // Transfer Refs
    const transferRef = useRef<TransferState | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    // ============================================================================
    // UTILITIES
    // ============================================================================

    const log = (message: string, ...args: unknown[]) => {
        console.log(`[FusionShare] ${message}`, ...args);
    };

    const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return window.btoa(binary);
    };

    const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
        const binary_string = window.atob(base64);
        const len = binary_string.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary_string.charCodeAt(i);
        }
        return bytes.buffer;
    };

    const sendWsMessage = useCallback((type: MessageType | string, payload: Record<string, unknown> = {}) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type, ...payload }));
        }
    }, []);

    // ============================================================================
    // FILE TRANSFER LOGIC
    // ============================================================================

    /**
     * Prepares file for transfer by splitting into chunks
     */
    const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file || !dataChannelRef.current || dataChannelRef.current.readyState !== 'open') return;

        // Prevent simultaneous transfers
        if (appState === AppState.TRANSFERRING) {
            log('Transfer already in progress');
            return;
        }

        setProgress(0);
        setCanResume(false);
        setAppState(AppState.TRANSFERRING);
        setStatusMessage(`Preparing ${file.name}...`);

        try {
            const buffer = await file.arrayBuffer();
            const totalChunks = Math.ceil(buffer.byteLength / CHUNK_SIZE);
            const fileId = generateId();

            // Prepare chunks (Memory intensive, but simple for now)
            const chunks: string[] = [];
            for (let i = 0; i < totalChunks; i++) {
                const start = i * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, buffer.byteLength);
                const chunk = buffer.slice(start, end);
                chunks.push(arrayBufferToBase64(chunk));
            }

            // Initialize transfer state
            transferRef.current = {
                fileId,
                fileName: file.name,
                fileSize: file.size,
                totalChunks,
                chunks,
                currentChunkIndex: 0,
                startTime: Date.now()
            };

            // Send Metadata
            const meta: FileMeta = {
                type: 'FILE_META',
                fileId,
                name: file.name,
                size: file.size,
                mimeType: file.type,
                chunkSize: CHUNK_SIZE,
                totalChunks
            };

            log('Sending metadata', meta);
            dataChannelRef.current.send(JSON.stringify(meta));

            // Start sending chunks
            sendNextChunk();

        } catch (error) {
            console.error('[FusionShare] Error preparing file:', error);
            setStatusMessage('Error preparing file');
            setAppState(AppState.CONNECTED);
        }
    };

    /**
     * Sends the next chunk in the queue
     */
    const sendNextChunk = () => {
        const transfer = transferRef.current;
        if (!transfer || !dataChannelRef.current) return;

        // Check for completion
        if (transfer.currentChunkIndex >= transfer.totalChunks) {
            log('Transfer complete');
            setStatusMessage(`Sent ${transfer.fileName} successfully!`);
            setAppState(AppState.CONNECTED);
            if (fileInputRef.current) fileInputRef.current.value = '';

            // Cleanup memory (chunks array is already mostly nullified by now)
            transfer.chunks = [];
            return;
        }

        const chunkIndex = transfer.currentChunkIndex;

        // Memory optimization: Free previous chunk as it's been acknowledged
        if (chunkIndex > 0) {
            transfer.chunks[chunkIndex - 1] = null;
        }

        const chunkData = transfer.chunks[chunkIndex] as string;

        // Verify chunk exists (in case of resume logic quirks)
        if (!chunkData) {
            console.error('[FusionShare] Chunk data missing for index', chunkIndex);
            return;
        }

        const message: ChunkMessage = {
            type: 'FILE_CHUNK',
            fileId: transfer.fileId,
            index: chunkIndex,
            data: chunkData
        };

        try {
            dataChannelRef.current.send(JSON.stringify(message));

            // Update UI
            const percent = Math.round(((chunkIndex + 1) / transfer.totalChunks) * 100);
            setProgress(percent);
            setStatusMessage(`Sending... ${percent}%`);
        } catch (e) {
            console.error('[FusionShare] Failed to send chunk', e);
            setCanResume(true);
            setStatusMessage('Transfer interrupted');
        }
    };

    /**
     * Handles incoming DataChannel messages
     */
    const handleIncomingData = useCallback((data: string) => {
        try {
            const message = JSON.parse(data);

            // ----------------------------------------
            // SENDER: Handle ACK and Resume
            // ----------------------------------------
            if (message.type === 'CHUNK_ACK') {
                const ack = message as AckMessage;
                const transfer = transferRef.current;

                if (transfer && transfer.fileId === ack.fileId) {
                    if (ack.index === transfer.currentChunkIndex) {
                        transfer.currentChunkIndex++;
                        sendNextChunk();
                    }
                }
                return;
            }

            if (message.type === 'RESUME_REQUEST') {
                const req = message as ResumeRequest;
                const transfer = transferRef.current;

                if (transfer && transfer.fileId === req.fileId) {
                    log(`Resuming from chunk ${req.lastReceivedChunk + 1}`);
                    transfer.currentChunkIndex = req.lastReceivedChunk + 1;
                    sendNextChunk();
                }
                return;
            }

            // ----------------------------------------
            // RECEIVER: Handle Meta and Chunks
            // ----------------------------------------

            if (message.type === 'FILE_META') {
                const meta = message as FileMeta;

                // Prevent duplicate transfers
                if (transferRef.current) {
                    log('Ignoring new transfer request while busy');
                    return;
                }

                log('Received metadata', meta);

                transferRef.current = {
                    fileId: meta.fileId,
                    fileName: meta.name,
                    fileSize: meta.size,
                    totalChunks: meta.totalChunks,
                    chunks: [],
                    currentChunkIndex: 0,
                    startTime: Date.now()
                };

                setAppState(AppState.TRANSFERRING);
                setProgress(0);
                setStatusMessage(`Receiving ${meta.name}...`);
                return;
            }

            if (message.type === 'FILE_CHUNK') {
                const chunk = message as ChunkMessage;
                const transfer = transferRef.current;

                if (!transfer || transfer.fileId !== chunk.fileId) return;

                // Validate order
                if (chunk.index !== transfer.currentChunkIndex) {
                    console.warn(`[FusionShare] Out of order chunk. Expected ${transfer.currentChunkIndex}, got ${chunk.index}`);
                    return;
                }

                // Decode and store
                const buffer = base64ToArrayBuffer(chunk.data);
                transfer.chunks.push(buffer);
                transfer.currentChunkIndex++;

                // Update UI
                const percent = Math.round((transfer.currentChunkIndex / transfer.totalChunks) * 100);
                setProgress(percent);
                setStatusMessage(`Receiving... ${percent}%`);

                // Send ACK
                const ack: AckMessage = {
                    type: 'CHUNK_ACK',
                    fileId: transfer.fileId,
                    index: chunk.index
                };
                dataChannelRef.current?.send(JSON.stringify(ack));

                // Check completion
                if (transfer.currentChunkIndex >= transfer.totalChunks) {
                    log('File received completely');

                    try {
                        const blob = new Blob(transfer.chunks as ArrayBuffer[], { type: 'application/octet-stream' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = transfer.fileName;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(url);

                        setStatusMessage(`Received ${transfer.fileName} successfully!`);
                    } catch (e) {
                        console.error('[FusionShare] File save error', e);
                        setStatusMessage('Error saving file');
                    }

                    setAppState(AppState.CONNECTED);
                    transferRef.current = null; // Clear memory
                }
                return;
            }

        } catch (e) {
            console.error('[FusionShare] Error parsing message:', e);
        }
    }, []);

    const handleResume = () => {
        const transfer = transferRef.current;
        if (!transfer || !dataChannelRef.current) return;

        if (userRole === 'receiver') {
            const lastChunk = transfer.currentChunkIndex - 1;
            const req: ResumeRequest = {
                type: 'RESUME_REQUEST',
                fileId: transfer.fileId,
                lastReceivedChunk: lastChunk
            };
            log('Requesting resume', req);
            dataChannelRef.current.send(JSON.stringify(req));
            setCanResume(false);
        }

        if (userRole === 'sender') {
            log('Retrying current chunk...');
            sendNextChunk();
            setCanResume(false);
        }
    };

    // ============================================================================
    // WEBRTC LIFECYCLE
    // ============================================================================

    const cleanupWebRTC = useCallback(() => {
        log('Cleaning up WebRTC');
        if (dataChannelRef.current) {
            dataChannelRef.current.close();
        }
        if (peerConnectionRef.current) {
            peerConnectionRef.current.close();
        }

        transferRef.current = null;
        pendingCandidatesRef.current = [];
        setIsWebRTCConnected(false);
        setAppState((prev) => prev === AppState.TRANSFERRING ? AppState.CONNECTED : prev);
    }, []);

    const setupDataChannel = useCallback((channel: RTCDataChannel, role: 'sender' | 'receiver') => {
        log(`Setting up DataChannel as ${role}`);
        dataChannelRef.current = channel;

        channel.onopen = () => {
            log('DataChannel opened');
            setIsWebRTCConnected(true);

            if (transferRef.current && role === 'receiver') {
                log('Connection restored, can resume');
                setCanResume(true);
                setStatusMessage('Connection restored. Click Resume to continue.');
            }
        };

        channel.onmessage = (event) => {
            handleIncomingData(event.data);
        };

        channel.onclose = () => {
            log('DataChannel closed');
            setIsWebRTCConnected(false);
            if (transferRef.current) {
                setCanResume(true);
                setStatusMessage('Transfer paused (Connection lost)');
            }
        };
    }, [handleIncomingData]);

    const createPeerConnection = useCallback((role: 'sender' | 'receiver') => {
        const pc = new RTCPeerConnection(RTC_CONFIG);
        peerConnectionRef.current = pc;

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                sendWsMessage(MessageType.ICE_CANDIDATE, {
                    candidate: event.candidate.toJSON()
                });
            }
        };

        if (role === 'receiver') {
            pc.ondatachannel = (event) => {
                setupDataChannel(event.channel, 'receiver');
            };
        }

        return pc;
    }, [sendWsMessage, setupDataChannel]);

    // ============================================================================
    // SIGNALING HANDLERS
    // ============================================================================

    const initiateSenderConnection = useCallback(async () => {
        const pc = createPeerConnection('sender');
        const channel = pc.createDataChannel(DATA_CHANNEL_NAME);
        setupDataChannel(channel, 'sender');

        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            sendWsMessage(MessageType.RTC_OFFER, { sdp: offer });
        } catch (error) {
            console.error('[WebRTC] Failed to create offer:', error);
        }
    }, [createPeerConnection, setupDataChannel, sendWsMessage]);

    const handleRTCOffer = useCallback(async (sdp: RTCSessionDescriptionInit) => {
        const pc = createPeerConnection('receiver');
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
            for (const candidate of pendingCandidatesRef.current) {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            }
            pendingCandidatesRef.current = [];
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendWsMessage(MessageType.RTC_ANSWER, { sdp: answer });
        } catch (error) {
            console.error('[WebRTC] Failed to handle offer:', error);
        }
    }, [createPeerConnection, sendWsMessage]);

    const handleRTCAnswer = useCallback(async (sdp: RTCSessionDescriptionInit) => {
        const pc = peerConnectionRef.current;
        if (!pc) return;
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
            for (const candidate of pendingCandidatesRef.current) {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            }
            pendingCandidatesRef.current = [];
        } catch (error) {
            console.error('[WebRTC] Failed to set remote description:', error);
        }
    }, []);

    const handleICECandidate = useCallback(async (candidate: RTCIceCandidateInit) => {
        const pc = peerConnectionRef.current;
        if (!pc || !pc.remoteDescription) {
            pendingCandidatesRef.current.push(candidate);
            return;
        }
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }, []);

    const handleMessage = useCallback((event: MessageEvent) => {
        try {
            const message = JSON.parse(event.data);
            switch (message.type) {
                case MessageType.ROOM_CREATED:
                    setRoomId(message.roomId);
                    setAppState(AppState.ROOM_CREATED);
                    setUserRole('sender');
                    break;
                case MessageType.ROOM_JOINED:
                    setRoomId(message.roomId);
                    setAppState(AppState.CONNECTED);
                    setUserRole('receiver');
                    setShowJoinInput(false);
                    break;
                case MessageType.PEER_JOINED:
                    setAppState(AppState.CONNECTED);
                    initiateSenderConnection();
                    break;
                case MessageType.PEER_DISCONNECTED:
                    cleanupWebRTC();
                    setUserRole((role) => {
                        if (role === 'sender') setAppState(AppState.ROOM_CREATED);
                        else {
                            setAppState(AppState.ERROR);
                            setRoomId(null);
                            setErrorMessage('Connection lost.');
                            setTimeout(() => setAppState(AppState.IDLE), 100);
                        }
                        return role === 'sender' ? 'sender' : null;
                    });
                    break;
                case MessageType.ERROR:
                    setErrorMessage(getFriendlyError(message.message));
                    setAppState((cur) => cur === AppState.ROOM_JOINING ? AppState.IDLE : cur);
                    break;
                case MessageType.RTC_OFFER: handleRTCOffer(message.sdp); break;
                case MessageType.RTC_ANSWER: handleRTCAnswer(message.sdp); break;
                case MessageType.ICE_CANDIDATE: handleICECandidate(message.candidate); break;
            }
        } catch (e) { console.error('WS Error', e); }
    }, [initiateSenderConnection, cleanupWebRTC, handleRTCOffer, handleRTCAnswer, handleICECandidate]);

    // ============================================================================
    // APPLICATION LIFECYCLE
    // ============================================================================

    const connectWebSocket = useCallback(() => {
        const ws = new WebSocket('ws://localhost:8080');
        wsRef.current = ws;
        ws.onopen = () => { setIsConnected(true); setErrorMessage(null); };
        ws.onclose = () => setIsConnected(false);
        ws.onmessage = handleMessage;
        ws.onerror = () => setErrorMessage('Connection lost.');
        return ws;
    }, [handleMessage]);

    useEffect(() => {
        if (mountedRef.current) return;
        mountedRef.current = true;
        connectWebSocket();
        return () => { mountedRef.current = false; cleanupWebRTC(); wsRef.current?.close(); };
    }, [connectWebSocket, cleanupWebRTC]);

    // ============================================================================
    // QR CODE & URL LOGIC
    // ============================================================================

    // 1. Generate QR Code for Sender
    useEffect(() => {
        if (userRole === 'sender' && roomId) {
            const url = `${window.location.protocol}//${window.location.host}?room=${roomId}`;
            QRCode.toDataURL(url, { margin: 1, width: 200 })
                .then(setQrCodeUrl)
                .catch(err => console.error('[FusionShare] QR Generation Error:', err));
        } else {
            setQrCodeUrl('');
        }
    }, [userRole, roomId]);

    // 2. Parse URL for Auto-Join
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const roomParam = params.get('room');
        if (roomParam && isConnected && appState === AppState.IDLE) {
            log('Auto-joining room from URL:', roomParam);
            setJoinCode(roomParam);
            // Small delay to ensure state updates
            setTimeout(() => {
                setAppState(AppState.ROOM_JOINING);
                sendWsMessage(MessageType.JOIN_ROOM, { roomId: roomParam });
                // Clean URL
                window.history.replaceState({}, '', '/');
            }, 100);
        }
    }, [isConnected, appState, sendWsMessage]);

    // 3. Scanner Logic
    const startScanner = () => {
        setShowScanner(true);
        // Defer scanner init to ensure DOM element exists
        setTimeout(() => {
            if (!scannerRef.current) {
                const scanner = new Html5QrcodeScanner(
                    "reader",
                    { fps: 10, qrbox: { width: 250, height: 250 } },
                    /* verbose= */ false
                );
                scannerRef.current = scanner;

                scanner.render(
                    (decodedText) => {
                        log('QR Code scanned:', decodedText);
                        handleScanSuccess(decodedText);
                    },
                    (_) => {
                        // ignore scan errors, they happen on every frame
                    }
                );
            }
        }, 100);
    };

    const stopScanner = () => {
        if (scannerRef.current) {
            scannerRef.current.clear().catch(console.error);
            scannerRef.current = null;
        }
        setShowScanner(false);
    };

    const handleScanSuccess = (decodedText: string) => {
        stopScanner();
        try {
            // Try to parse URL param
            let code = decodedText;
            if (decodedText.includes('?room=')) {
                const url = new URL(decodedText);
                code = url.searchParams.get('room') || '';
            }

            if (code && code.length === 4) {
                setJoinCode(code);
                setAppState(AppState.ROOM_JOINING);
                sendWsMessage(MessageType.JOIN_ROOM, { roomId: code });
            } else {
                setErrorMessage('Invalid QR Code');
            }
        } catch (e) {
            console.error('QR Parse Error', e);
            setErrorMessage('Invalid QR Code');
        }
    };

    // ============================================================================
    // ACTIONS & RENDER
    // ============================================================================

    // Actions
    const handleCreateRoom = () => {
        if (appState !== AppState.IDLE) return;
        sendWsMessage(MessageType.CREATE_ROOM);
    };
    const handleJoinRoom = () => {
        if (appState !== AppState.IDLE) return;
        setShowJoinInput(true);
    };
    const handleJoinSubmit = () => {
        if (joinCode.length !== 4) return;
        setAppState(AppState.ROOM_JOINING);
        sendWsMessage(MessageType.JOIN_ROOM, { roomId: joinCode });
    };

    const handleLeaveRoom = () => {
        if (appState === AppState.TRANSFERRING) {
            if (!confirm('Transfer in progress. Are you sure you want to leave?')) return;
        }

        stopScanner();
        cleanupWebRTC();
        if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
        setAppState(AppState.IDLE);
        setRoomId(null);
        setUserRole(null);
        setShowJoinInput(false);
        setJoinCode('');
        if (fileInputRef.current) fileInputRef.current.value = '';
        setStatusMessage('');
        setProgress(0);
        setTimeout(connectWebSocket, 100);
    };

    // ============================================================================
    // RENDER HELPERS
    // ============================================================================

    const getStatusText = () => {
        if (statusMessage) return statusMessage;
        if (appState === AppState.CONNECTED) return 'Ready to transfer files';
        if (appState === AppState.ROOM_CREATED) return 'Waiting for peer...';
        return '';
    };

    const renderProgressBar = () => {
        if (appState !== AppState.TRANSFERRING && !canResume) return null;
        return (
            <div className="progress-container">
                <div className="progress-bar" style={{ width: `${progress}%` }} />
                <span className="progress-text">{progress}%</span>
            </div>
        );
    };

    const renderContent = () => {
        // Scanner Overlay
        if (showScanner) {
            return (
                <div className="scanner-overlay">
                    <div id="reader" className="scanner-box"></div>
                    <button className="btn btn-secondary mt-4" onClick={stopScanner}>Cancel Scan</button>
                </div>
            );
        }

        if (appState === AppState.IDLE) {
            return showJoinInput ? (
                <div className="join-form">
                    <input className="join-input" value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} maxLength={4} />
                    <button className="btn btn-primary" onClick={handleJoinSubmit}>Join</button>
                    <div className="scanner-actions">
                        <button className="btn btn-secondary" onClick={startScanner}>📷 Scan QR</button>
                        <button className="btn btn-secondary" onClick={() => { setShowScanner(false); setShowJoinInput(false); }}>Cancel</button>
                    </div>
                </div>
            ) : (
                <div className="actions">
                    <button className="btn btn-primary" onClick={handleCreateRoom} disabled={!isConnected}>Create Room</button>
                    <button className="btn btn-secondary" onClick={handleJoinRoom} disabled={!isConnected}>Join Room</button>
                </div>
            );
        }

        return (
            <div className="room-info">
                <div className="room-code-container">
                    <span className="room-code-label">Room Code</span>
                    <span className="room-code">{roomId}</span>
                </div>

                {qrCodeUrl && (
                    <div className="qr-code-container">
                        <img src={qrCodeUrl} alt="Room QR Code" className="qr-code-image" />
                        <p className="qr-hint">Scan to join instantly</p>
                    </div>
                )}

                {userRole && (
                    <div className="role-badge">
                        {userRole === 'sender' ? '📤 Sender' : '📥 Receiver'}
                    </div>
                )}

                <p className="room-status">{getStatusText()}</p>

                {renderProgressBar()}

                {canResume && (
                    <button className="btn btn-primary" onClick={handleResume}>
                        Resume Transfer
                    </button>
                )}

                {userRole === 'sender' && appState === AppState.CONNECTED && (
                    <div className="file-transfer-ui">
                        <input type="file" ref={fileInputRef} onChange={handleFileSelect} className="file-input" />
                        <button className="btn btn-primary" onClick={() => fileInputRef.current?.click()}>
                            Select File
                        </button>
                    </div>
                )}

                <div className="webrtc-status">
                    <span className={`status-dot ${isWebRTCConnected ? 'connected' : 'disconnected'}`} />
                    <span>{isWebRTCConnected ? 'WebRTC connected' : 'Connecting...'}</span>
                </div>

                <button className="btn btn-secondary" onClick={handleLeaveRoom}>Leave Room</button>
            </div>
        );
    };

    return (
        <div className="container">
            <header className="header">
                <h1 className="title">Fusion Share</h1>
                <p className="subtitle">Cross-device file sharing</p>
            </header>
            <div className="status">
                <span className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`} />
                <span className="status-text">{isConnected ? 'Connected' : 'Reconnecting...'}</span>
            </div>
            {errorMessage && <div className="error-message">{errorMessage}</div>}
            <main className="main-content">{renderContent()}</main>
        </div>
    );
}

export default App;
