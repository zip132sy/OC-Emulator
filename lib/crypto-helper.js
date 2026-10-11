#!/usr/bin/env node
// ============================================================
// crypto-helper.js - Data card crypto operations bridge
//
// Usage: node crypto-helper.js <operation> <inputFile> [args...]
//   Operations:
//     md5 <inputFile>                          → hex string
//     sha256 <inputFile>                        → hex string
//     deflate <inputFile>                       → base64 string
//     inflate <inputFile>                       → raw string (base64 input)
//     encrypt <inputFile> <keyFile>             → base64 string (AES-256-CBC)
//     decrypt <inputFile> <keyFile>              → raw string (AES-256-CBC)
//     generateKeyPair [bits]                    → JSON {public, private}
//     sign <inputFile> <privateKeyFile>          → base64 signature
//     verify <inputFile> <signatureFile> <pubKeyFile> → "true" or "false"
//     diffieHellman <privateKeyFile> <pubKeyFile> → base64 shared secret
//
// Input files are read as binary; output goes to stdout.
// ============================================================
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');

function readBase64(p) {
  const raw = fs.readFileSync(p, 'utf8').trim();
  return Buffer.from(raw, 'base64');
}
function writeBase64(data) {
  process.stdout.write(Buffer.from(data).toString('base64'));
}
function writeRaw(data) {
  process.stdout.write(data);
}

function main() {
  const op = process.argv[2];
  if (!op) {
    process.stderr.write('Usage: node crypto-helper.js <operation> <inputFile> [args...]\n');
    process.exit(1);
  }

  try {
    switch (op) {
      case 'md5': {
        const data = fs.readFileSync(process.argv[3]);
        const hash = crypto.createHash('md5').update(data).digest('hex');
        process.stdout.write(hash);
        break;
      }
      case 'sha256': {
        const data = fs.readFileSync(process.argv[3]);
        const hash = crypto.createHash('sha256').update(data).digest('hex');
        process.stdout.write(hash);
        break;
      }
      case 'deflate': {
        const data = fs.readFileSync(process.argv[3]);
        const compressed = zlib.deflateSync(data, { level: 9 });
        writeBase64(compressed);
        break;
      }
      case 'inflate': {
        // Input file contains base64-encoded deflated data
        const data = readBase64(process.argv[3]);
        const decompressed = zlib.inflateSync(data);
        writeRaw(decompressed);
        break;
      }
      case 'encrypt': {
        // AES-256-CBC, key = SHA-256(keyString), IV = random 16 bytes (prepended to output)
        const data = fs.readFileSync(process.argv[3]);
        const keyStr = fs.readFileSync(process.argv[4], 'utf8').trim();
        const key = crypto.createHash('sha256').update(keyStr).digest();
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
        // Output: base64(iv + encrypted)
        writeBase64(Buffer.concat([iv, encrypted]));
        break;
      }
      case 'decrypt': {
        // Input file contains base64(iv + encrypted), key file has the key string
        const combined = readBase64(process.argv[3]);
        const keyStr = fs.readFileSync(process.argv[4], 'utf8').trim();
        const key = crypto.createHash('sha256').update(keyStr).digest();
        const iv = combined.subarray(0, 16);
        const encrypted = combined.subarray(16);
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        writeRaw(decrypted);
        break;
      }
      case 'generateKeyPair': {
        const bits = parseInt(process.argv[3] || '2048', 10);
        const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
          modulusLength: bits,
          publicKeyEncoding: { type: 'spki', format: 'pem' },
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });
        const result = JSON.stringify({
          public: publicKey.toString('base64'),
          private: privateKey.toString('base64'),
        });
        process.stdout.write(result);
        break;
      }
      case 'sign': {
        const data = fs.readFileSync(process.argv[3]);
        const keyPem = fs.readFileSync(process.argv[4], 'utf8').trim();
        const keyB64 = keyPem.includes('-----') ? keyPem : Buffer.from(keyPem, 'base64').toString('utf8');
        const sign = crypto.sign('sha256', data, crypto.createPrivateKey(keyB64));
        writeBase64(sign);
        break;
      }
      case 'verify': {
        const data = fs.readFileSync(process.argv[3]);
        const sigB64 = fs.readFileSync(process.argv[4], 'utf8').trim();
        const signature = Buffer.from(sigB64, 'base64');
        const pubPem = fs.readFileSync(process.argv[5], 'utf8').trim();
        const pubB64 = pubPem.includes('-----') ? pubPem : Buffer.from(pubPem, 'base64').toString('utf8');
        const verified = crypto.verify('sha256', data, crypto.createPublicKey(pubB64), signature);
        process.stdout.write(verified ? 'true' : 'false');
        break;
      }
      case 'diffieHellman': {
        // Generate DH key exchange
        // Input: privateKey (Alice's), publicKey (Bob's) - both as PEM files
        const aliceKeyPem = fs.readFileSync(process.argv[3], 'utf8').trim();
        const alicePriv = crypto.createPrivateKey(aliceKeyPem);
        // For simplicity, use ECDH instead of DH
        // This is a simplified version
        const bobPubPem = fs.readFileSync(process.argv[4], 'utf8').trim();
        const bobPub = crypto.createPublicKey(bobPubPem);
        const secret = crypto.diffieHellman({
          privateKey: alicePriv,
          publicKey: bobPub,
        });
        writeBase64(secret);
        break;
      }
      default:
        process.stderr.write(`Unknown operation: ${op}\n`);
        process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
}

main();
