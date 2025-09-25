import { config } from './config.js';

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

// Singleton pattern for NEAR connection management
class NearConnectionManager {
  private static instance: NearConnectionManager;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  // near-api-js properties (sandbox)
  private nearApiJsNear: any = null;
  private nearApiJsAccount: any = null;

  // @eclipseeer/near-api-ts properties (testnet/mainnet)
  private eclipseeerClient: any = null;
  private eclipseeerKeyService: any = null;
  private eclipseeerSigner: any = null;

  private isUsingNearApiJs = false;

  private constructor() {}

  static getInstance(): NearConnectionManager {
    if (!NearConnectionManager.instance) {
      NearConnectionManager.instance = new NearConnectionManager();
    }
    return NearConnectionManager.instance;
  }

  async init(): Promise<void> {
    if (this.initialized) {
      console.log('🔄 NEAR connection already initialized, skipping...');
      return;
    }

    if (this.initPromise) {
      console.log('⏳ NEAR initialization in progress, waiting...');
      return this.initPromise;
    }

    this.initPromise = this._initInternal();
    return this.initPromise;
  }

  private async _initInternal(): Promise<void> {
    try {
      console.log('🚀 Starting NEAR connection initialization...');

      // Determine which library to use based on network
      if (config.networkId === 'sandbox') {
        await this.initNearApiJs();
      } else if (config.networkId === 'testnet' || config.networkId === 'mainnet') {
        await this.initEclipseeerNearApiTs();
      } else {
        throw new Error(`Unsupported networkId: ${config.networkId}. Supported: sandbox, testnet, mainnet`);
      }

      this.initialized = true;
      console.log('✅ NEAR connection initialization completed successfully');
    } catch (error) {
      console.error('❌ NEAR connection initialization failed:', error);
      this.initPromise = null;
      throw error;
    }
  }

  private async initNearApiJs(): Promise<void> {
    // Use near-workspaces to connect to existing sandbox
    const { Worker } = await import('near-workspaces');

    // Connect to existing sandbox instead of creating new one
    const worker = await Worker.init({
      network: 'sandbox',
      // Don't create new sandbox, connect to existing
      rm: false,
      // Use the existing sandbox home directory
      homeDir: process.env.NEAR_HOME || `${process.env.HOME}/.near`,
    });

    const masterAccount = worker.rootAccount;

    // Store references for later use
    this.nearApiJsNear = { worker };
    this.nearApiJsAccount = masterAccount;

    console.log(`🔍 Sandbox Account Debug:`);
    console.log(`   - Connected to existing sandbox via near-workspaces`);
    console.log(`   - Master account:`, masterAccount.accountId);
    console.log(`   - Using existing sandbox (rm: false)`);

    this.isUsingNearApiJs = true;
    console.log(`✅ NEAR init: near-workspaces (sandbox) - Connected to existing sandbox`);
  }

  private async initEclipseeerNearApiTs(): Promise<void> {
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
    this.eclipseeerClient = createClient({ network });

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

    this.eclipseeerKeyService = await createMemoryKeyService({
      keySources,
    } as any);

    // Derive public keys for key pool, if available
    let signingKeys: string[] = [];
    try {
      const keyPairs = (this.eclipseeerKeyService as any).getKeyPairs
        ? (this.eclipseeerKeyService as any).getKeyPairs()
        : {};
      signingKeys = Object.keys(keyPairs);
    } catch {
      // ignore, fallback to library's internal selection if not available
      signingKeys = [];
    }

    // Create signer with optional key pool for load distribution
    this.eclipseeerSigner = await createMemorySigner({
      signerAccountId: config.masterAccount,
      client: this.eclipseeerClient,
      keyService: this.eclipseeerKeyService,
      ...(signingKeys.length > 0 ? { keyPool: { signingKeys } } : {}),
    } as any);

    this.isUsingNearApiJs = false;
    console.log(
      `✅ NEAR init: @eclipseeer/near-api-ts (keys=${privateKeys.length}, rpcUrls=${rpcUrlsEnv ? rpcUrlsEnv.split(',').length : 1}, headers=${Object.keys(headers).length})`
    );
  }

  getNear(): any {
    if (!this.initialized) {
      throw new Error('NEAR connection not initialized. Call init() first.');
    }

    if (this.isUsingNearApiJs) {
      if (!this.nearApiJsAccount) {
        throw new Error('Sandbox account not initialized');
      }
      // For near-workspaces, return the account directly
      return { account: this.nearApiJsAccount, worker: this.nearApiJsNear.worker };
    } else {
      if (!this.eclipseeerSigner) {
        throw new Error('Testnet signer not initialized');
      }
      // Return @eclipseeer/near-api-ts interface (Signer)
      return { signer: this.eclipseeerSigner, client: this.eclipseeerClient };
    }
  }

  async cleanup(): Promise<void> {
    if (this.isUsingNearApiJs && this.nearApiJsNear?.worker) {
      console.log('🧹 Cleaning up NEAR sandbox worker...');
      try {
        await this.nearApiJsNear.worker.tearDown();
        console.log('✅ Sandbox worker cleaned up successfully');
      } catch (error) {
        console.error('❌ Error cleaning up sandbox worker:', error);
      }
    }
  }
}

// Export singleton instance functions for backward compatibility
const connectionManager = NearConnectionManager.getInstance();

export const initNear = () => connectionManager.init();
export const getNear = () => connectionManager.getNear();

// Cleanup function for graceful shutdown
export const cleanupNear = () => connectionManager.cleanup();