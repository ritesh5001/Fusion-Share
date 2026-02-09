import { useEffect, useState, useRef, useCallback } from 'react';

// Message types (must match backend)
enum MessageType {
    CREATE_ROOM = 'CREATE_ROOM',
    JOIN_ROOM = 'JOIN_ROOM',
    ROOM_CREATED = 'ROOM_CREATED',
    ROOM_JOINED = 'ROOM_JOINED',
    PEER_JOINED = 'PEER_JOINED',
    PEER_DISCONNECTED = 'PEER_DISCONNECTED',
    ERROR = 'ERROR'
}

// Room states
type RoomState = 'idle' | 'creating' | 'waiting' | 'joining' | 'connected';

// User role
type UserRole = 'none' | 'sender' | 'receiver';

function App() {
    const [isConnected, setIsConnected] = useState(false);
    const [roomState, setRoomState] = useState<RoomState>('idle');
    const [roomId, setRoomId] = useState<string | null>(null);
    const [userRole, setUserRole] = useState<UserRole>('none');
    const [statusMessage, setStatusMessage] = useState<string>('');
    const [errorMessage, setErrorMessage] = useState<string>('');
    const [showJoinInput, setShowJoinInput] = useState(false);
    const [joinCode, setJoinCode] = useState('');

    const wsRef = useRef<WebSocket | null>(null);

    // Send message helper
    const sendMessage = useCallback((type: MessageType, payload: Record<string, unknown> = {}) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type, ...payload }));
        }
    }, []);

    // Handle incoming messages
    const handleMessage = useCallback((event: MessageEvent) => {
        try {
            const message = JSON.parse(event.data);
            console.log('Received:', message);

            switch (message.type) {
                case MessageType.ROOM_CREATED:
                    setRoomId(message.roomId);
                    setRoomState('waiting');
                    setUserRole('sender');
                    setStatusMessage('Waiting for another device to join...');
                    setErrorMessage('');
                    break;

                case MessageType.ROOM_JOINED:
                    setRoomId(message.roomId);
                    setRoomState('connected');
                    setUserRole('receiver');
                    setStatusMessage('Connected to sender');
                    setErrorMessage('');
                    setShowJoinInput(false);
                    setJoinCode('');
                    break;

                case MessageType.PEER_JOINED:
                    setRoomState('connected');
                    setStatusMessage('Device connected');
                    break;

                case MessageType.PEER_DISCONNECTED:
                    if (userRole === 'sender') {
                        setRoomState('waiting');
                        setStatusMessage('Peer disconnected. Waiting for another device...');
                    } else {
                        // Receiver's room was closed
                        setRoomState('idle');
                        setRoomId(null);
                        setUserRole('none');
                        setStatusMessage('');
                        setErrorMessage(message.message || 'Connection lost');
                    }
                    break;

                case MessageType.ERROR:
                    setErrorMessage(message.message || 'Something went wrong');
                    setRoomState(roomState === 'creating' ? 'idle' : roomState === 'joining' ? 'idle' : roomState);
                    break;

                default:
                    console.log('Unknown message type:', message.type);
            }
        } catch (error) {
            console.error('Failed to parse message:', error);
        }
    }, [roomState, userRole]);

    useEffect(() => {
        const ws = new WebSocket('ws://localhost:8080');
        wsRef.current = ws;

        ws.onopen = () => {
            console.log('Connected to server');
            setIsConnected(true);
        };

        ws.onclose = () => {
            console.log('Disconnected from server');
            setIsConnected(false);
            setRoomState('idle');
            setRoomId(null);
            setUserRole('none');
        };

        ws.onmessage = handleMessage;

        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };

        return () => {
            ws.close();
        };
    }, [handleMessage]);

    const handleCreateRoom = () => {
        setRoomState('creating');
        setStatusMessage('Creating room...');
        setErrorMessage('');
        sendMessage(MessageType.CREATE_ROOM);
    };

    const handleJoinRoom = () => {
        setShowJoinInput(true);
        setErrorMessage('');
    };

    const handleJoinSubmit = () => {
        if (!joinCode.trim()) {
            setErrorMessage('Please enter a room code');
            return;
        }
        setRoomState('joining');
        setStatusMessage('Joining room...');
        setErrorMessage('');
        sendMessage(MessageType.JOIN_ROOM, { roomId: joinCode.toUpperCase() });
    };

    const handleCancelJoin = () => {
        setShowJoinInput(false);
        setJoinCode('');
        setErrorMessage('');
    };

    const handleLeaveRoom = () => {
        // Close and reconnect to leave room
        wsRef.current?.close();
        setRoomState('idle');
        setRoomId(null);
        setUserRole('none');
        setStatusMessage('');
        setErrorMessage('');
        setShowJoinInput(false);
        setJoinCode('');
    };

    // Render based on room state
    const renderContent = () => {
        // Show room code and status when in room
        if (roomState === 'waiting' || roomState === 'connected') {
            return (
                <div className="room-info">
                    <div className="room-code-container">
                        <span className="room-code-label">Room Code</span>
                        <span className="room-code">{roomId}</span>
                    </div>
                    <p className="room-status">{statusMessage}</p>
                    {roomState === 'connected' && (
                        <div className="role-badge">
                            {userRole === 'sender' ? '📤 Sender' : '📥 Receiver'}
                        </div>
                    )}
                    <button className="btn btn-secondary" onClick={handleLeaveRoom}>
                        Leave Room
                    </button>
                </div>
            );
        }

        // Show join room input
        if (showJoinInput) {
            return (
                <div className="join-form">
                    <input
                        type="text"
                        className="join-input"
                        placeholder="Enter room code"
                        value={joinCode}
                        onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                        maxLength={4}
                        autoFocus
                    />
                    <div className="join-actions">
                        <button
                            className="btn btn-primary"
                            onClick={handleJoinSubmit}
                            disabled={!joinCode.trim()}
                        >
                            Join
                        </button>
                        <button className="btn btn-secondary" onClick={handleCancelJoin}>
                            Cancel
                        </button>
                    </div>
                </div>
            );
        }

        // Show create/join buttons
        return (
            <div className="actions">
                <button
                    className="btn btn-primary"
                    onClick={handleCreateRoom}
                    disabled={!isConnected || roomState === 'creating'}
                >
                    {roomState === 'creating' ? 'Creating...' : 'Create Room'}
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

    return (
        <div className="container">
            <header className="header">
                <h1 className="title">Fusion Share</h1>
                <p className="subtitle">Cross-device file sharing</p>
            </header>

            <div className="status">
                <span className={`status-dot ${isConnected ? 'connected' : 'disconnected'}`}></span>
                <span className="status-text">
                    {isConnected ? 'Connected' : 'Disconnected'}
                </span>
            </div>

            {errorMessage && (
                <div className="error-message">{errorMessage}</div>
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
