// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
createServer((request,response)=>{response.writeHead(request.url === '/ready' ? 200 : 404);response.end(request.url === '/ready' ? 'owned-container-ready' : 'missing');}).listen(8080,'0.0.0.0');
// The image itself also exits even if the controlling Worker and alarm are unavailable.
setTimeout(()=>process.exit(0),180_000);
