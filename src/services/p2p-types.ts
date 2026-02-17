
export interface PeerInfo {
    name: string;
    ip?: string;
    clientId: number;
    source: 'local' | 'internet' | 'both' | 'unknown';
}

export interface PeerState {
    name: string;
    ip?: string;
    [key: string]: any;
}
