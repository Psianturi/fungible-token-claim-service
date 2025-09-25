// src/near-utils.ts
import { Buffer } from 'buffer';

export async function rpcViewFunction(nodeUrl: string, contractId: string, methodName: string, args: any = {}) {
  const body = {
    jsonrpc: "2.0",
    id: "dontcare",
    method: "query",
    params: {
      request_type: "call_function",
      account_id: contractId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
      finality: "optimistic",
    },
  };

  const res = await fetch(nodeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const j = await res.json();
  if (j.error) {
    throw new Error(JSON.stringify(j.error));
  }
  // result.result is array of bytes
  const raw = Buffer.from(j.result.result).toString();
  try {
    return JSON.parse(raw);
  } catch (e) {
    return raw;
  }
}

/**
 * Try multiple provider/account APIs before falling back to raw RPC.
 * - account.viewFunction(contractId, method, args)  (near-api-js)
 * - account.view(contractId, method, args)          (near-workspaces maybe)
 * - account.viewCall / account.call / worker.view?  (other variants)
 * - fallback to rpcViewFunction(nodeUrl,...)
 */
export async function safeView(account: any | undefined, nodeUrl: string, contractId: string, methodName: string, args: any = {}) {
  try {
    if (account) {
      if (typeof account.viewFunction === 'function') {
        return await account.viewFunction(contractId, methodName, args);
      }
      if (typeof account.view === 'function') {
        // near-workspaces: account.view(contractId, method, args)
        return await account.view(contractId, methodName, args);
      }
      if (typeof account.viewCall === 'function') {
        return await account.viewCall(contractId, methodName, args);
      }
      if (typeof account.call === 'function' && methodName && args !== undefined) {
        // Some libs might use contract wrappers; skip direct call attempt for view (call will make tx)
      }
    }
    // fallback to RPC query
    return await rpcViewFunction(nodeUrl, contractId, methodName, args);
  } catch (e) {
    // bubble up; caller will handle retry/error
    throw e;
  }
}