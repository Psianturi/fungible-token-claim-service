import { config } from './config.js';

// Hybrid approach: different libraries for different environments
let nearClient: any;
let nearAccount: any;
let nearApiJsNear: any;
let nearApiJsAccount: any;
let isUsingNearApiJs = false;

// For @eclipseeer/near-api-ts (testnet/mainnet)
let eclipseeerClient: any;
let eclipseeerKeyService: any;
let eclipseeerSigner: any;


const normalizeKey = (pk: string): string => {
 let s = (pk || '').trim();
 if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
   s = s.slice(1, -1);
 }
 if (!s.startsWith('ed25519:') && !s.startsWith('secp256k1:')) {
   s = `ed25519:${s}`;
 }
 const idx = s.indexOf(':');
 if (idx === -1) return s;
 const curve = s.slice(0, idx);
 
 let body = s.slice(idx + 1).replace(/\s+/g, '');
 return `${curve}:${body}`;
};

export const initNear = async () => {
  // Determine which library to use based on network
  if (config.networkId === 'sandbox') {
    await initNearApiJs();
  } else if (config.networkId === 'testnet' || config.networkId === 'mainnet') {
    await initEclipseeerNearApiTs();
  } else {
    throw new Error(`Unsupported networkId: ${config.networkId}. Supported: sandbox, testnet, mainnet`);
  }
};

// Initialize with @eclipseeer/near-api-ts for sandbox (more reliable)
const initEclipseeerForSandbox = async () => {
  const {
    createClient,
    createMemoryKeyService,
    createMemorySigner,
  } = await import('@eclipseeer/near-api-ts');

  // Use custom RPC for sandbox
  const network = {
    rpcs: {
      regular: [{ url: config.nodeUrl || 'http://localhost:24278' }],
      archival: [{ url: config.nodeUrl || 'http://localhost:24278' }],
    },
  };

 
  eclipseeerClient = createClient({ network });

  // Get private key from env
  const privateKeyEnv = process.env.MASTER_ACCOUNT_PRIVATE_KEY;
  if (!privateKeyEnv) {
    throw new Error('MASTER_ACCOUNT_PRIVATE_KEY environment variable is required');
  }
  const privateKey = normalizeKey(privateKeyEnv);

  // Create key service
  eclipseeerKeyService = await createMemoryKeyService({
    keySources: [{ privateKey }],
  } as any);

  // Create signer
  eclipseeerSigner = await createMemorySigner({
    signerAccountId: config.masterAccount,
    client: eclipseeerClient,
    keyService: eclipseeerKeyService,
  } as any);

  isUsingNearApiJs = false;
  console.log(`✅ NEAR init: @eclipseeer/near-api-ts (sandbox)`);
};

const initNearApiJs = async () => {
  const { connect, keyStores, KeyPair } = await import('near-api-js');

  // Build network configuration
  const networkConfig = {
    networkId: config.networkId,
    nodeUrl: config.nodeUrl || 'http://localhost:3030',
    walletUrl: config.walletUrl || 'http://localhost:4000/wallet',
    helperUrl: config.helperUrl || 'https://helper.testnet.near.org',
    explorerUrl: config.explorerUrl || 'http://localhost:9001/explorer',
  };

  // Setup keystore with private key from env
  const keyStore = new keyStores.InMemoryKeyStore();

  // Get private key from env
  const privateKeyEnv = process.env.MASTER_ACCOUNT_PRIVATE_KEY;
  if (!privateKeyEnv) {
    throw new Error('MASTER_ACCOUNT_PRIVATE_KEY environment variable is required for sandbox');
  }
  const normalizedKey = normalizeKey(privateKeyEnv);
  const keyPair = KeyPair.fromString(normalizedKey as any);
  await keyStore.setKey(config.networkId, config.masterAccount, keyPair);

  // Connect to NEAR
  nearApiJsNear = await connect({ ...networkConfig, keyStore });

  // CRITICAL: Create account using the connection that has the keyStore
  nearApiJsAccount = await nearApiJsNear.account(config.masterAccount);

  // CRITICAL: Explicitly set the signer account ID
  nearApiJsAccount.signerAccountId = config.masterAccount;

  // DEBUGGING: Verify account properties
  console.log(`🔍 Sandbox Account Debug:`);
  console.log(`   - nearApiJsAccount.accountId:`, nearApiJsAccount.accountId);
  console.log(`   - nearApiJsAccount.signerAccountId:`, nearApiJsAccount.signerAccountId);
  console.log(`   - keyPair publicKey:`, keyPair.getPublicKey().toString());

  // Use account directly for transactions
  nearAccount = nearApiJsAccount;

  isUsingNearApiJs = true;
  console.log(`✅ NEAR init: near-api-js (${config.networkId})`);
};

// Initialize with @eclipseeer/near-api-ts for testnet/mainnet (high performance)
const initEclipseeerNearApiTs = async () => {
  const {
    createClient,
    createMemoryKeyService,
    createMemorySigner,
    testnet,
    mainnet,
  } = await import('@eclipseeer/near-api-ts');

  let network: any;
  const rpcUrlsEnv = process.env.RPC_URLS;

  // Build common headers if provided
  const headers: Record<string, string> = {};
  const fastnearKey = process.env.FASTNEAR_API_KEY;
  if (fastnearKey) headers['x-api-key'] = fastnearKey;
  const rpcHeadersEnv = process.env.RPC_HEADERS; // e.g. {"x-api-key":"...","authorization":"Bearer ..."}
  if (rpcHeadersEnv) {
    try {
      const extra = JSON.parse(rpcHeadersEnv);
      if (extra && typeof extra === 'object') {
        Object.assign(headers, extra as Record<string, string>);
      }
    } catch {
      console.warn('Invalid RPC_HEADERS JSON, ignoring');
    }
  }
  const maybeWithHeaders = (url: string) =>
    Object.keys(headers).length > 0 ? { url, headers } : { url };

  if (rpcUrlsEnv) {
    const urls = rpcUrlsEnv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (urls.length === 0) {
      throw new Error('RPC_URLS provided but no valid URLs found');
    }
    network = {
      rpcs: {
        regular: urls.map((url) => maybeWithHeaders(url)),
        archival: urls.map((url) => maybeWithHeaders(url)),
      },
    };
  } else if (config.nodeUrl) {
    network = {
      rpcs: {
        regular: [maybeWithHeaders(config.nodeUrl)],
        archival: [maybeWithHeaders(config.nodeUrl)],
      },
    };
  } else if (config.networkId === 'testnet') {
    network = testnet;
  } else if (config.networkId === 'mainnet') {
    network = mainnet;
  } else {
    throw new Error(`Unsupported networkId: ${config.networkId}. Only testnet and mainnet are supported with @eclipseeer/near-api-ts.`);
  }

  // Create client
  eclipseeerClient = createClient({ network });

  // Create key service from one or more private keys
  // Env:
  //  - MASTER_ACCOUNT_PRIVATE_KEYS="ed25519:...,ed25519:...,..." (preferred for high-load)
  //  - MASTER_ACCOUNT_PRIVATE_KEY="ed25519:..." (single-key fallback)
  console.log('🔍 Environment variables check:');
  console.log('MASTER_ACCOUNT_PRIVATE_KEY exists:', !!process.env.MASTER_ACCOUNT_PRIVATE_KEY);
  console.log('MASTER_ACCOUNT_PRIVATE_KEYS exists:', !!process.env.MASTER_ACCOUNT_PRIVATE_KEYS);

  const keysEnv = process.env.MASTER_ACCOUNT_PRIVATE_KEYS;
  let privateKeys: string[] = [];
  if (keysEnv && keysEnv.trim().length > 0) {
    privateKeys = keysEnv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    console.log('Using MASTER_ACCOUNT_PRIVATE_KEYS with', privateKeys.length, 'keys');
  } else {
    const single = process.env.MASTER_ACCOUNT_PRIVATE_KEY;
    if (!single) {
      console.error('❌ Environment variables dump:', Object.keys(process.env).filter(key => key.includes('MASTER') || key.includes('PRIVATE')));
      throw new Error(
        'MASTER_ACCOUNT_PRIVATE_KEY or MASTER_ACCOUNT_PRIVATE_KEYS environment variable is required'
      );
    }
    privateKeys = [single];
    console.log('Using MASTER_ACCOUNT_PRIVATE_KEY');
  }

  // Sanitize and normalize all keys from env to avoid base58 errors
  privateKeys = privateKeys.map(normalizeKey);

  // Build key sources
  const keySources = privateKeys.map((privateKey) => ({ privateKey }));

  eclipseeerKeyService = await createMemoryKeyService({
    keySources,
  } as any);

  // Derive public keys for key pool, if available
  let signingKeys: string[] = [];
  try {
    const keyPairs = (eclipseeerKeyService as any).getKeyPairs
      ? (eclipseeerKeyService as any).getKeyPairs()
      : {};
    signingKeys = Object.keys(keyPairs);
  } catch {
    // ignore, fallback to library's internal selection if not available
    signingKeys = [];
  }

  // Create signer with optional key pool for load distribution
  eclipseeerSigner = await createMemorySigner({
    signerAccountId: config.masterAccount,
    client: eclipseeerClient,
    keyService: eclipseeerKeyService,
    ...(signingKeys.length > 0 ? { keyPool: { signingKeys } } : {}),
  } as any);

  isUsingNearApiJs = false;
  console.log(
    `✅ NEAR init: @eclipseeer/near-api-ts (keys=${privateKeys.length}, rpcUrls=${rpcUrlsEnv ? rpcUrlsEnv.split(',').length : 1}, headers=${Object.keys(headers).length})`
  );
};

export const getNear = () => {
  if (isUsingNearApiJs) {
    if (!nearAccount) {
      throw new Error('NEAR connection not initialized. Call initNear() first.');
    }
    // Return near-api-js interface (Account)
    return { account: nearAccount, near: nearApiJsNear };
  } else {
    if (!eclipseeerSigner) {
      throw new Error('NEAR connection not initialized. Call initNear() first.');
    }
    // Return @eclipseeer/near-api-ts interface (Signer)
    return { signer: eclipseeerSigner, client: eclipseeerClient };
  }
};