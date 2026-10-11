// lib/internetProxy.js
// HTTP proxy for OpenComputers' `internet.request()` calls.
//
// Primary: Node's built-in global `fetch` (Node 18+).
// Fallback: PowerShell's Invoke-WebRequest (handles system proxy automatically).
//
// The OC internet card streams a response in chunks; to match that shape we
// slice the response body into an array of strings. No streaming for v1 -
// we fetch the whole body, then chunk it deterministically.

const { execFile } = require('child_process');

class InternetProxy {
  /**
   * @param {{ timeout?: number, usePowerShellFallback?: boolean }} options
   * @param {number} [options.timeout=30000] Default request timeout in ms.
   * @param {boolean} [options.usePowerShellFallback=true] Fallback to PowerShell when fetch fails.
   */
  constructor({ timeout = 60000, usePowerShellFallback = true } = {}) {
    this.timeout = timeout;
    this.usePowerShellFallback = usePowerShellFallback;
  }

  /**
   * Issue an HTTP request and return the response in the OC-expected shape.
   *
   * @param {object} opts
   * @param {string} opts.url         - URL to fetch
   * @param {string} [opts.method="GET"]
   * @param {object} [opts.headers={}] - header name -> value
   * @param {string|null} [opts.body=null] - request body (string)
   * @param {string|number} [opts.reqId]  - echoed back in the response
   * @param {number} [opts.timeout]    - per-call timeout, overrides default
   * @returns {Promise<{
   *   reqId: *,
   *   status: number,
   *   statusText: string,
   *   headers: object,
   *   chunks: string[],
   *   ok: boolean,
   *   error?: null,
   * }|{
   *   reqId: *,
   *   status: 0,
   *   statusText: string,
   *   headers: object,
   *   chunks: string[],
   *   ok: boolean,
   *   error: string,
   * }>}
   */
  async request({ url, method = "GET", headers = {}, body = null, reqId, timeout }) {
    const effectiveTimeout = timeout != null ? timeout : this.timeout;

    // Normalize URL: decode %2F (path separator encoding) back to /
    // Some clients (e.g., MineOS installer) encode entire path including slashes,
    // which can cause issues with proxies, firewalls, or certain servers.
    let normalizedUrl = url;
    try {
      // Only decode path separators, not other encoded chars
      normalizedUrl = url.replace(/%2F/g, '/').replace(/%2f/g, '/');
    } catch (e) {
      // If URL parsing fails, use original
    }

    // Normalize header names to a plain object of strings.
    const fetchHeaders = {};
    if (headers && typeof headers === "object") {
      for (const [key, value] of Object.entries(headers)) {
        if (value === undefined || value === null) continue;
        fetchHeaders[key] = String(value);
      }
    }

    const fetchMethod = String(method || "GET").toUpperCase();

    // Build the fetch init. Body only valid for non-GET/HEAD per fetch spec.
    const init = {
      method: fetchMethod,
      headers: fetchHeaders,
    };
    if (body != null && fetchMethod !== "GET" && fetchMethod !== "HEAD") {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(0, effectiveTimeout),
    );
    init.signal = controller.signal;

    try {
      // Retry on transient network errors (ECONNRESET, ConnectTimeoutError, etc.)
      const maxRetries = 3;
      let lastError = null;
      let response = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          if (attempt > 0) {
            console.log(`[internetProxy] retry ${attempt}/${maxRetries} for: ${normalizedUrl.substring(0, 100)}`);
            await new Promise(r => setTimeout(r, 1000 * attempt));
            // Fresh controller for each retry
            const retryController = new AbortController();
            const retryTimer = setTimeout(() => retryController.abort(), Math.max(0, effectiveTimeout));
            init.signal = retryController.signal;
            response = await fetch(normalizedUrl, init);
            clearTimeout(retryTimer);
          } else {
            console.log(`[internetProxy] calling fetch: ${normalizedUrl.substring(0, 100)}`);
            response = await fetch(normalizedUrl, init);
          }
          console.log(`[internetProxy] fetch returned: status=${response.status}`);
          break;
        } catch (fetchErr) {
          lastError = fetchErr;
          console.log(`[internetProxy] fetch attempt ${attempt} failed: name=${fetchErr.name} cause=${JSON.stringify(fetchErr.cause)}`);
          if (attempt < maxRetries) {
            const cause = fetchErr.cause || {};
            const causeCode = cause.code || cause.name || '';
            const isTransient = causeCode === 'ECONNRESET' ||
              causeCode === 'UND_ERR_CONNECT_TIMEOUT' ||
              causeCode === 'ETIMEDOUT' ||
              causeCode === 'ECONNREFUSED' ||
              causeCode === 'ConnectTimeoutError' ||
              fetchErr.name === 'TypeError';
            console.log(`[internetProxy] isTransient=${isTransient} causeCode=${causeCode}`);
            if (isTransient) {
              console.log(`[internetProxy] retrying ${attempt + 1}/${maxRetries}...`);
              continue;
            }
          }
          throw fetchErr;
        }
      }
      if (!response) throw lastError;

      let text = "";
      if (fetchMethod !== "HEAD") {
        // Read as binary to preserve byte values for non-text files (e.g. OC .pic images)
        // response.text() decodes as UTF-8, corrupting binary data.
        // Instead, read as ArrayBuffer and convert each byte to a Latin-1 char (code 0-255).
        const ab = await response.arrayBuffer();
        text = this._bufferToLatin1(Buffer.from(ab));
      }

      const chunks = this._chunkText(text);

      const respHeaders = this._flattenHeaders(response.headers);

      clearTimeout(timer);
      return {
        reqId,
        status: response.status,
        statusText: response.statusText || "",
        headers: respHeaders,
        chunks,
        ok: response.ok,
        error: null,
      };
    } catch (err) {
      const aborted = err && (err.name === "AbortError" || controller.signal.aborted);
      const message = aborted
        ? `request timed out after ${effectiveTimeout}ms`
        : (err && err.message) ? err.message : String(err);
      console.log(`[internetProxy] fetch error: name=${err?.name} message=${err?.message} cause=${JSON.stringify(err?.cause)} aborted=${aborted}`);

      // Fallback to PowerShell if fetch fails (network / proxy issues)。
      // 仅在 Windows 启用: 其它平台没有 PowerShell, 调用必然失败, 直接跳过。
      const canUsePsFallback = this.usePowerShellFallback && process.platform === 'win32';
      if (canUsePsFallback && !aborted) {
        console.log(`[internetProxy] falling back to PowerShell for: ${normalizedUrl.substring(0, 100)}`);
        try {
          const psResult = await this._requestPowerShell({
            url: normalizedUrl, method: fetchMethod, headers: fetchHeaders, body, timeout: effectiveTimeout,
          });
          clearTimeout(timer);
          return {
            reqId,
            status: psResult.status,
            statusText: psResult.statusText || "",
            headers: psResult.headers || {},
            chunks: this._chunkText(psResult.body || ""),
            ok: psResult.status >= 200 && psResult.status < 300,
            error: null,
          };
        } catch (psErr) {
          console.log(`[internetProxy] PowerShell fallback also failed: ${psErr.message}`);
          // If PowerShell also fails, return the original error
        }
      }

      clearTimeout(timer);
      return {
        reqId,
        status: 0,
        statusText: aborted ? "Timeout" : "Error",
        headers: {},
        chunks: [],
        ok: false,
        error: message,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Convert a Buffer to a Latin-1 string where each byte (0-255) maps to
   * a single character with the same code. This preserves binary data
   * through JSON serialization (non-ASCII chars get \uXXXX escapes).
   * @param {Buffer} buf
   * @returns {string}
   */
  _bufferToLatin1(buf) {
    // Process in chunks to avoid call stack limits on large files
    const CHUNK = 8192;
    let parts = [];
    for (let i = 0; i < buf.length; i += CHUNK) {
      parts.push(buf.toString('latin1', i, Math.min(i + CHUNK, buf.length)));
    }
    return parts.join('');
  }

  /**
   * Slice text into 1KB chunks to mimic OC's chunked reads.
   * @param {string} text
   * @returns {string[]}
   */
  _chunkText(text) {
    const CHUNK_SIZE = 1024;
    const chunks = [];
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
      chunks.push(text.slice(i, i + CHUNK_SIZE));
    }
    if (chunks.length === 0) chunks.push("");
    return chunks;
  }

  /**
   * Flatten fetch Headers into a plain object.
   * @param {Headers} headers
   * @returns {object}
   */
  _flattenHeaders(headers) {
    const respHeaders = {};
    headers.forEach((value, name) => {
      if (respHeaders[name] !== undefined) {
        respHeaders[name] = respHeaders[name] + "," + value;
      } else {
        respHeaders[name] = value;
      }
    });
    return respHeaders;
  }

  /**
   * Make an HTTP request using PowerShell's Invoke-WebRequest.
   * This handles Windows system proxy settings automatically.
   * @param {object} opts
   * @returns {{status: number, statusText: string, headers: object, body: string}}
   */
  async _requestPowerShell({ url, method, headers, body, timeout }) {
    const timeoutSec = Math.max(1, Math.ceil(timeout / 1000));

    // Build PowerShell script
    let psScript = `$ErrorActionPreference = 'Stop';\n`;
    psScript += `$headers = @{};\n`;

    // Add headers
    if (headers && typeof headers === "object") {
      for (const [key, value] of Object.entries(headers)) {
        const safeKey = key.replace(/'/g, "''");
        const safeVal = String(value).replace(/'/g, "''");
        psScript += `$headers['${safeKey}'] = '${safeVal}';\n`;
      }
    }

    // Build command - use try/catch to handle HTTP errors (4xx/5xx)
    // PowerShell 5.1 Invoke-WebRequest throws on non-2xx status codes.
    // Body is output as base64 to preserve binary data (e.g. OC .pic images).
    const safeUrl = url.replace(/'/g, "''");
    psScript += `try {\n`;
    if (body != null && method !== "GET" && method !== "HEAD") {
      const safeBody = String(body).replace(/'/g, "''");
      psScript += `$body = '${safeBody}';\n`;
      psScript += `$r = Invoke-WebRequest -Uri '${safeUrl}' -Method ${method} -Headers $headers -Body $body -UseBasicParsing -TimeoutSec ${timeoutSec};\n`;
    } else {
      psScript += `$r = Invoke-WebRequest -Uri '${safeUrl}' -Method ${method} -Headers $headers -UseBasicParsing -TimeoutSec ${timeoutSec};\n`;
    }
    psScript += `} catch {\n`;
    psScript += `  if ($_.Exception.Response) {\n`;
    psScript += `    # HTTP error response - read the response stream as raw bytes\n`;
    psScript += `    $respStream = $_.Exception.Response.GetResponseStream();\n`;
    psScript += `    $ms = New-Object System.IO.MemoryStream;\n`;
    psScript += `    $respStream.CopyTo($ms);\n`;
    psScript += `    $respStream.Close();\n`;
    psScript += `    $bodyBytes = $ms.ToArray();\n`;
    psScript += `    $ms.Close();\n`;
    psScript += `    Write-Output "STATUS:$([int]$_.Exception.Response.StatusCode)";\n`;
    psScript += `    Write-Output "HEADERS_START";\n`;
    psScript += `    foreach ($h in $_.Exception.Response.Headers.Keys) { Write-Output "$h=$($_.Exception.Response.Headers[$h])" };\n`;
    psScript += `    Write-Output "HEADERS_END";\n`;
    psScript += `    Write-Output "BODY_B64_START";\n`;
    psScript += `    Write-Output [Convert]::ToBase64String($bodyBytes);\n`;
    psScript += `    Write-Output "BODY_END";\n`;
    psScript += `    exit 0\n`;
    psScript += `  } else {\n`;
    psScript += `    # Real connection error - re-throw\n`;
    psScript += `    throw\n`;
    psScript += `  }\n`;
    psScript += `}\n`;

    psScript += `Write-Output "STATUS:$($r.StatusCode)";\n`;
    psScript += `Write-Output "HEADERS_START";\n`;
    psScript += `foreach ($h in $r.Headers.Keys) { Write-Output "$h=$($r.Headers[$h])" };\n`;
    psScript += `Write-Output "HEADERS_END";\n`;
    psScript += `Write-Output "BODY_B64_START";\n`;
    psScript += `$bodyBytes = $r.RawContentStream.ToArray();\n`;
    psScript += `Write-Output [Convert]::ToBase64String($bodyBytes);\n`;
    psScript += `Write-Output "BODY_END";\n`;

    try {
      // Try common PowerShell paths (System32 may not be in PATH when server launched directly)
      const fs = require('fs');
      let psExe = 'powershell.exe';
      const candidates = [
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe',
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) { psExe = c; break; }
      }
      const stdout = await new Promise((resolve, reject) => {
        // 必须用异步 execFile: execFileSync 会冻结整个 Node 事件循环
        // (最长可达 timeout + 5s), 期间所有 VM 与 HTTP 接口都会停止响应,
        // 还可能触发看门狗的 10 秒健康检查导致服务器被误杀。
        execFile(psExe, [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          psScript,
        ], {
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
          timeout: timeout + 5000,
          windowsHide: true,
        }, (err, out) => (err ? reject(err) : resolve(out || '')));
      });

      return this._parsePowerShellOutput(stdout);
    } catch (err) {
      // PowerShell might return error via stderr, but we capture stdout
      // If the command fails, re-throw with a meaningful message
      throw new Error(`PowerShell request failed: ${err.message}`);
    }
  }

  /**
   * Parse the structured output from PowerShell.
   * @param {string} output
   * @returns {{status: number, statusText: string, headers: object, body: string}}
   */
  _parsePowerShellOutput(output) {
    const lines = output.split(/\r?\n/);
    let status = 0;
    const headers = {};
    let body = "";
    let mode = "init"; // init | headers | body | body_b64
    let b64Parts = [];

    for (const line of lines) {
      if (mode === "init") {
        if (line.startsWith("STATUS:")) {
          status = parseInt(line.substring(7), 10) || 0;
        } else if (line === "HEADERS_START") {
          mode = "headers";
        }
      } else if (mode === "headers") {
        if (line === "HEADERS_END") {
          mode = "body";
        } else {
          const eqIdx = line.indexOf("=");
          if (eqIdx > 0) {
            const key = line.substring(0, eqIdx).toLowerCase();
            const value = line.substring(eqIdx + 1);
            if (headers[key]) {
              headers[key] += "," + value;
            } else {
              headers[key] = value;
            }
          }
        }
      } else if (mode === "body") {
        if (line === "BODY_B64_START") {
          mode = "body_b64";
          b64Parts = [];
        } else if (line === "BODY_START") {
          // legacy text mode (skip marker)
        } else if (line === "BODY_END") {
          break;
        } else {
          body += (body ? "\n" : "") + line;
        }
      } else if (mode === "body_b64") {
        if (line === "BODY_END") {
          // Decode base64 to Latin-1 string (preserves binary byte values)
          body = this._bufferToLatin1(Buffer.from(b64Parts.join(""), "base64"));
          break;
        } else {
          b64Parts.push(line);
        }
      }
    }

    return {
      status,
      statusText: status ? "OK" : "Error",
      headers,
      body,
    };
  }
}

module.exports = { InternetProxy };
