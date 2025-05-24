const serverless = require("serverless-http");
const express = require('express');
const net = require('net');
const dns = require('dns');
const dgram = require('dgram');

const app = express();

const port = process.env.PORT || 3000;


app.use(express.json());

// Java Edition Pinger
function createVarInt(value) {
  const bytes = [];
  while (true) {
    if ((value & 0xffffff80) === 0) {
      bytes.push(value);
      return Buffer.from(bytes);
    }
    bytes.push(value & 0x7f | 0x80);
    value >>>= 7;
  }
}

function createPacket(id, data) {
  const idBuffer = createVarInt(id);
  const lengthBuffer = createVarInt(idBuffer.length + data.length);
  return Buffer.concat([lengthBuffer, idBuffer, data]);
}

function readVarInt(buffer, offset) {
  let value = 0;
  let size = 0;
  let byte;
  do {
    byte = buffer[offset++];
    value |= (byte & 0x7f) << (size++ * 7);
    if (size > 5) {
      throw new Error('VarInt is too big');
    }
  } while (byte & 0x80);
  return [value, offset];
}

function connectToJavaServer(host, port) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let buffer = Buffer.alloc(0);
    let serverInfo;
    let pingStartTime;
    let hasResolvedOrRejected = false;

    // Set a timeout for the entire operation
    const overallTimeout = setTimeout(() => {
      if (!hasResolvedOrRejected) {
        hasResolvedOrRejected = true;
        client.destroy();
        const error = new Error('timeout');
        error.code = 'TIMEOUT';
        reject(error);
      }
    }, 7000); // 7 seconds

    client.setTimeout(7000); // Set socket timeout

    client.connect(port, host, () => {
      const hostBuffer = Buffer.from(host, 'utf8');
      const portBuffer = Buffer.alloc(2);
      portBuffer.writeUInt16BE(port, 0);
      const handshakeData = Buffer.concat([
        createVarInt(-1),
        createVarInt(hostBuffer.length),
        hostBuffer,
        portBuffer,
        createVarInt(1)
      ]);
      const handshakePacket = createPacket(0x00, handshakeData);
      client.write(handshakePacket);
      const statusRequestPacket = createPacket(0x00, Buffer.alloc(0));
      client.write(statusRequestPacket);
    });

    client.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      try {
        let offset = 0;
        let [length, newOffset] = readVarInt(buffer, offset);
        offset = newOffset;
        if (buffer.length >= offset + length) {
          let [packetId, newOffset] = readVarInt(buffer, offset);
          offset = newOffset;
          if (packetId === 0x00) {
            let [jsonLength, newOffset] = readVarInt(buffer, offset);
            offset = newOffset;
            const jsonResponse = buffer.slice(offset, offset + jsonLength).toString('utf8');
            serverInfo = JSON.parse(jsonResponse);
            const pingPacket = createPacket(0x01, Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]));
            pingStartTime = process.hrtime.bigint();
            client.write(pingPacket);
            buffer = buffer.slice(offset + jsonLength);
          } else if (packetId === 0x01) {
            const latency = Number(process.hrtime.bigint() - pingStartTime) / 1e6;
            serverInfo.latency = Math.round(latency);
            if (!hasResolvedOrRejected) {
              hasResolvedOrRejected = true;
              clearTimeout(overallTimeout);
              client.destroy();
              resolve(serverInfo);
            }
          }
        }
      } catch (e) {
        if (!hasResolvedOrRejected) {
          hasResolvedOrRejected = true;
          clearTimeout(overallTimeout);
          client.destroy();
          reject(e);
        }
      }
    });

    client.on('error', (err) => {
      if (!hasResolvedOrRejected) {
        hasResolvedOrRejected = true;
        clearTimeout(overallTimeout);
        client.destroy();
        reject(err);
      }
    });

    client.on('timeout', () => {
      if (!hasResolvedOrRejected) {
        hasResolvedOrRejected = true;
        clearTimeout(overallTimeout);
        client.destroy();
        const error = new Error('timeout');
        error.code = 'TIMEOUT';
        reject(error);
      }
    });

    client.on('close', () => {
      console.log('Connection closed');
    });
  });
}

// Bedrock Edition Pinger
function createBedrockPacket() {
  const packetId = Buffer.from([0x01]);
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeBigUInt64BE(BigInt(Date.now()), 0);
  const magic = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');
  const clientGUID = Buffer.alloc(8);
  clientGUID.writeBigUInt64BE(BigInt(Math.floor(Math.random() * 1e15)), 0);
  return Buffer.concat([packetId, timeBuffer, magic, clientGUID]);
}

function readBedrockResponse(buffer) {
  const packetId = buffer.readUInt8(0);
  if (packetId !== 0x1c) {
    throw new Error('Invalid packet ID');
  }
  const offset = 35;
  const serverInfoStr = buffer.slice(offset).toString('utf8');
  const serverInfoParts = serverInfoStr.split(';');
  return {
    edition: serverInfoParts[0],
    motd: serverInfoParts[1],
    protocol: parseInt(serverInfoParts[2], 10),
    version: serverInfoParts[3],
    playersOnline: parseInt(serverInfoParts[4], 10),
    playersMax: parseInt(serverInfoParts[5], 10),
    serverId: serverInfoParts[6],
    worldname: serverInfoParts[7],
    gameMode: serverInfoParts[8],
    nintendoLimited: serverInfoParts[9],
    portIPv4: serverInfoParts[10],
    portIPv6: serverInfoParts[11]
  };
}

function pingBedrockServer(host, port) {
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket('udp4');
    const pingPacket = createBedrockPacket();
    let hasResolvedOrRejected = false;

    const timeout = setTimeout(() => {
      if (!hasResolvedOrRejected) {
        hasResolvedOrRejected = true;
        client.close();
        const error = new Error('timeout');
        error.code = 'TIMEOUT';
        reject(error);
      }
    }, 7000); // 7 seconds

    client.on('message', (msg) => {
      if (!hasResolvedOrRejected) {
        hasResolvedOrRejected = true;
        clearTimeout(timeout);
        try {
          const serverInfo = readBedrockResponse(msg);
          const responseTime = BigInt(Date.now()) - BigInt(msg.readBigUInt64BE(1));
          serverInfo.latency = Number(responseTime);
          resolve(serverInfo);
        } catch (error) {
          reject(error);
        } finally {
          client.close();
        }
      }
    });

    client.on('error', (err) => {
      if (!hasResolvedOrRejected) {
        hasResolvedOrRejected = true;
        clearTimeout(timeout);
        client.close();
        reject(err);
      }
    });

    client.send(pingPacket, 0, pingPacket.length, port, host, (err) => {
      if (err) {
        if (!hasResolvedOrRejected) {
          hasResolvedOrRejected = true;
          clearTimeout(timeout);
          client.close();
          reject(err);
        }
      }
    });
  });
}

function extractText(obj) {
  let text = '';
  
  // Handle plain string
  if (typeof obj === 'string') {
    return obj;
  }
  
  // Handle color and formatting codes
  if (obj.color) {
    text += `§${getColorCode(obj.color)}`;
  }
  if (obj.bold) {
    text += '§l';
  }
  if (obj.italic) {
    text += '§o';
  }
  if (obj.underline) {
    text += '§n';
  }
  if (obj.strikethrough) {
    text += '§m';
  }
  if (obj.obfuscated) {
    text += '§k';
  }
  
  // Add text content
  if (obj.text) {
    text += obj.text;
  }
  
  // Process extra array with proper reset codes
  if (obj.extra) {
    for (let i = 0; i < obj.extra.length; i++) {
      const item = obj.extra[i];
      const hasFormatting = item.color || item.bold || item.italic || 
                          item.underline || item.strikethrough || item.obfuscated;
      
      // Add reset code between elements in the extra array if needed
      if (i > 0) {
        const prevItem = obj.extra[i - 1];
        const prevHasFormatting = prevItem.color || prevItem.bold || prevItem.italic || 
                               prevItem.underline || prevItem.strikethrough || prevItem.obfuscated;
        
        if (prevHasFormatting) {
          text += '§r';
        }
      }
      
      // Process the item recursively
      text += extractText(item);
    }
  }
  
  return text;
}

function removeColorCodes(text) {
  // Remove all Minecraft formatting codes (§ followed by any character)
  return text.replace(/§[0-9a-fklmnor]/gi, '');
}

function getColorCode(colorName) {
  const colorCodes = {
    black: '0',
    dark_blue: '1',
    dark_green: '2',
    dark_aqua: '3',
    dark_red: '4',
    dark_purple: '5',
    gold: '6',
    gray: '7',
    dark_gray: '8',
    blue: '9',
    green: 'a',
    aqua: 'b',
    red: 'c',
    light_purple: 'd',
    yellow: 'e',
    white: 'f'
  };
  return colorCodes[colorName] || 'f';
}

function resolveSrv(host) {
  return new Promise((resolve, reject) => {
    dns.resolveSrv(`_minecraft._tcp.${host}`, (err, addresses) => {
      if (err) {
        if (err.code === 'ENODATA' || err.code === 'ENOTFOUND') {
          resolve(null);
        } else {
          reject(err);
        }
      } else {
        resolve(addresses[0]);
      }
    });
  });
}

async function resolveAndConnect(host, port, isJava = true) {
  try {
    const srvRecord = await resolveSrv(host);
    if (srvRecord) {
      console.log(`SRV record found: ${srvRecord.name}:${srvRecord.port}`);
      host = srvRecord.name;
      port = srvRecord.port;
    }

    // Verify if the domain can be resolved
    await new Promise((resolve, reject) => {
      dns.lookup(host, (err, address) => {
        if (err) {
          reject(err);
        } else {
          resolve(address);
        }
      });
    });

    if (isJava) {
      return await connectToJavaServer(host, port);
    } else {
      return await pingBedrockServer(host, port);
    }
  } catch (error) {
    console.error('Error resolving or connecting:', error);
    throw error;
  }
}

app.get('/api/png/:serverip', async (req, res) => {
  const serverip = req.params.serverip;
  let [serverHost, serverPort] = serverip.split(':');
  serverPort = serverPort ? parseInt(serverPort) : 25565;

  try {
    const response = await resolveAndConnect(serverHost, serverPort);
    if (response.favicon && response.favicon.startsWith('data:image/png;base64,')) {
      const faviconData = response.favicon.split(',')[1];
      const faviconBuffer = Buffer.from(faviconData, 'base64');
      res.set('Content-Type', 'image/png');
      res.send(faviconBuffer);
    } else {
      res.json({ 
        success: false, 
        error: {
          code: 'no_favicon',
          message: 'Server does not have a favicon'
        }
      });
    }
  } catch (err) {
    console.error(err);
    let errorResponse = {
      success: false,
      error: {
        code: 'unknown_error',
        message: 'Failed to connect to the server'
      }
    };

    if (err.code === 'TIMEOUT') {
      errorResponse.error = {
        code: 'timeout',
        message: 'Connection to server timed out'
      };
    } else if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
      errorResponse.error = {
        code: 'invalid_domain',
        message: 'The domain name could not be resolved'
      };
    } else if (err.code === 'ECONNREFUSED') {
      errorResponse.error = {
        code: 'connection_refused',
        message: 'Server refused the connection'
      };
    } else {
      errorResponse.error = {
        code: 'offline',
        message: 'Server appears to be offline or unreachable'
      };
    }

    res.json(errorResponse);
  }
});

app.get('/api/status/:serverAddress', async (req, res) => {
  const [serverHost, serverPort] = req.params.serverAddress.split(':');
  const port = serverPort ? parseInt(serverPort, 10) : 25565;

  try {
    const response = await resolveAndConnect(serverHost, port);
    let description = '';
    if (typeof response.description === 'string') {
      description = response.description;
    } else if (response.description) {
      description = extractText(response.description);
    }

    const serverInfo = {
      success: true,
      version: response.version,
      players: {
        max: response.players.max,
        online: response.players.online,
        list: response.players.sample || []
      },
      description: description,
      description_clean: removeColorCodes(description),
      latency: response.latency,
      favicon: response.favicon
    };

    res.json(serverInfo);
  } catch (err) {
    console.error(err);
    let errorResponse = {
      success: false,
      error: {
        code: 'unknown_error',
        message: 'Failed to connect to the server'
      }
    };

    if (err.code === 'TIMEOUT') {
      errorResponse.error = {
        code: 'timeout',
        message: 'Connection to server timed out'
      };
    } else if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
      errorResponse.error = {
        code: 'invalid_domain',
        message: 'The domain name could not be resolved'
      };
    } else if (err.code === 'ECONNREFUSED') {
      errorResponse.error = {
        code: 'connection_refused',
        message: 'Server refused the connection'
      };
    } else {
      errorResponse.error = {
        code: 'offline',
        message: 'Server appears to be offline or unreachable'
      };
    }

    res.json(errorResponse);
  }
});

app.get('/api/status/bedrock/:serverAddress', async (req, res) => {
  const [serverHost, serverPort] = req.params.serverAddress.split(':');
  const port = serverPort ? parseInt(serverPort, 10) : 19132;

  try {
    const response = await resolveAndConnect(serverHost, port, false);
    const serverInfo = {
      success: true,
      motd: response.motd,
      motd_clean: removeColorCodes(response.motd),
      levelName: response.worldname,
      playersOnline: response.playersOnline,
      playersMax: response.playersMax,
      gamemode: response.gameMode,
      serverId: response.serverId,
      protocol: response.protocol,
      version: response.version,
      latency: response.latency
    };

    res.json(serverInfo);
  } catch (error) {
    console.error('Ping failed:', error);
    let errorResponse = {
      success: false,
      error: {
        code: 'unknown_error',
        message: 'Failed to connect to the server'
      }
    };

    if (error.code === 'TIMEOUT') {
      errorResponse.error = {
        code: 'timeout',
        message: 'Connection to server timed out'
      };
    } else if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
      errorResponse.error = {
        code: 'invalid_domain',
        message: 'The domain name could not be resolved'
      };
    } else if (error.code === 'ECONNREFUSED') {
      errorResponse.error = {
        code: 'connection_refused',
        message: 'Server refused the connection'
      };
    } else {
      errorResponse.error = {
        code: 'offline',
        message: 'Server appears to be offline or unreachable'
      };
    }

    res.json(errorResponse);
  }
});



app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});

app.use(`/api/`, router);

module.exports.handler = serverless(app);
