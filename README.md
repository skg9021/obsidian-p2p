# Obsidian Plugin P2P

This is a sample plugin for Obsidian (https://obsidian.md).

## Usage
...

## Development
1. `npm install`
2. `npm run dev` to start watching for changes
3. `npm run build` to build for production

## Features

- [X] Fix MQTT based signalling
- [ ] Verify that both local and MQTT based signalling works at the same time.
- [X] Connected clients discovery should show which client is local and which client is on MQTT based signalling
- [ ] Decouple blob and images from y.js CRDT based sync. This can add significant overhead on y.js

## Improvements

### Local Mode

1. Fix restart server to make sure server can be restarted, in case there are any issues.
2. If server/host is not up and IP is added on client, client keep on retrying at a constant frequency, there should be exponential backoff.
3. There should be find server option for client, to try connecting to host/server. This is useful specifically if client goes in exponential backoff.