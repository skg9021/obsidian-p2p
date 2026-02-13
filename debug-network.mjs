import os from 'os';

console.log('Network Interfaces:');
const nets = os.networkInterfaces();
console.log(JSON.stringify(nets, null, 2));

const results = [];
for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
        // Check filtering logic
        console.log(`Checking ${name}: family=${net.family}, internal=${net.internal}, address=${net.address}`);
        if (net.family === 'IPv4' && !net.internal) {
            results.push(net.address);
        }
    }
}
console.log('Detected IPs:', results);
