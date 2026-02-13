import { WebrtcService } from '../src/services/webrtc.service';
import { P2PSettings, DEFAULT_SETTINGS } from '../src/settings';
import { Notice } from 'obsidian';

jest.mock('obsidian');

// Mock WebRTC globals
global.RTCPeerConnection = jest.fn().mockImplementation(() => ({
    createDataChannel: jest.fn().mockReturnValue({
        onopen: null,
        onmessage: null,
        send: jest.fn(),
        readyState: 'open',
    }),
    createOffer: jest.fn().mockResolvedValue({ type: 'offer', sdp: 'sdp' }),
    createAnswer: jest.fn().mockResolvedValue({ type: 'answer', sdp: 'sdp' }),
    setLocalDescription: jest.fn(),
    setRemoteDescription: jest.fn(),
    addIceCandidate: jest.fn(),
    close: jest.fn(),
    onicecandidate: null,
    onconnectionstatechange: null,
    ondatachannel: null,
    connectionState: 'new',
})) as any;

global.RTCSessionDescription = jest.fn() as any;
global.RTCIceCandidate = jest.fn() as any;
global.btoa = (str: string) => Buffer.from(str).toString('base64');
global.atob = (str: string) => Buffer.from(str, 'base64').toString();


describe('WebrtcService', () => {
    let service: WebrtcService;
    let settings: P2PSettings;

    beforeEach(() => {
        settings = { ...DEFAULT_SETTINGS, deviceName: 'TestDevice' };
        service = new WebrtcService(settings);
    });

    afterEach(() => {
        service.destroy();
        jest.clearAllMocks();
    });

    it('should create a peer connection on OFFER', async () => {
        const onSignal = jest.fn();
        service.setCallbacks(jest.fn(), onSignal, jest.fn());

        const offer = { type: 'offer', sdp: 'offer-sdp' };
        await service.handleSignal({
            type: 'OFFER',
            sender: 'RemotePeer',
            payload: offer
        });

        // Verify peer created
        expect(service.peers.has('RemotePeer')).toBe(true);
        const pc = service.peers.get('RemotePeer');
        expect(pc).toBeDefined();
        // Since RTCPeerConnection is not mocked fully here, we check existence
    });

    it('should ignore signal from self', async () => {
        await service.handleSignal({
            type: 'HELLO',
            sender: 'TestDevice',
            payload: {}
        });
        expect(service.peers.size).toBe(0);
    });

    // Mocking RTCPeerConnection would be complex, so we stick to basic logic checks
});
