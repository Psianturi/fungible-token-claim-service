/**
 * Deploy FT contract to sandbox using near-api-js v2
 *
 * Required env:
 *   - NEAR_CONTRACT_ACCOUNT_ID (default test.near)
 *   - NEAR_SIGNER_ACCOUNT_ID (default test.near)
 *   - NEAR_SIGNER_ACCOUNT_PRIVATE_KEY (ed25519:...)
 *   - NEAR_NETWORK_CONNECTION (default sandbox)
 */
import { connect, keyStores, utils } from 'near-api-js';
import fs from 'fs';
import path from 'path';


async function main() {
  console.log('🚀 Deploy script started...');

  // Load environment variables
  const contractAccountId = process.env.NEAR_CONTRACT_ACCOUNT_ID || 'ft.test.near';
  const signerAccountId = process.env.NEAR_SIGNER_ACCOUNT_ID || 'test.near';
  const signerPrivateKey = process.env.NEAR_SIGNER_ACCOUNT_PRIVATE_KEY;
  const networkConnection = process.env.NEAR_NETWORK_CONNECTION || 'sandbox';

  if (!signerPrivateKey) {
    throw new Error('NEAR_SIGNER_ACCOUNT_PRIVATE_KEY is required');
  }

  // Check if WASM file exists
  const wasmPath = path.resolve(process.cwd(), 'fungible_token.wasm');
  if (!fs.existsSync(wasmPath)) {
    throw new Error(`fungible_token.wasm not found at: ${wasmPath}`);
  }

  console.log(`📦 Deploying contract to: ${contractAccountId}`);
  console.log(`🔑 Using signer: ${signerAccountId}`);
  console.log(`🌐 Network: ${networkConnection}`);

  // Setup key store - handle key format properly
  const keyStore = new keyStores.InMemoryKeyStore();
  let keyPair;
  try {
    // Try with full key first (ed25519:...)
    keyPair = utils.KeyPair.fromString(signerPrivateKey);
  } catch (error) {
    console.log('Failed to parse key with prefix, trying without prefix...');
    // If that fails, try without ed25519: prefix
    const keyWithoutPrefix = signerPrivateKey.replace(/^ed25519:/, '');
    keyPair = utils.KeyPair.fromString(keyWithoutPrefix);
  }
  await keyStore.setKey(networkConnection, signerAccountId, keyPair);

  // Connect to NEAR
  const near = await connect({
    networkId: networkConnection,
    keyStore,
    nodeUrl: 'http://127.0.0.1:3030',
  });

  // Get account handle
  const account = await near.account(signerAccountId);

  // Read WASM file
  const wasm = fs.readFileSync(wasmPath);
  console.log(`📄 WASM file size: ${wasm.length} bytes`);

  try {
    // Deploy contract
    console.log('🔨 Deploying contract...');
    await account.deployContract(wasm);
    console.log('✅ Contract deployed successfully!');

    // Initialize contract
    console.log('⚙️ Initializing contract...');
    await account.functionCall({
      contractId: contractAccountId,
      methodName: 'new_default_meta',
      args: {
        owner_id: signerAccountId,
        total_supply: '1000000000000000000000000000000'
      },
      gas: '300000000000000',
      attachedDeposit: '0'
    });
    console.log('✅ Contract initialized successfully!');

    // Register storage for signer account
    console.log('💾 Registering storage...');
    await account.functionCall({
      contractId: contractAccountId,
      methodName: 'storage_deposit',
      args: {
        account_id: signerAccountId,
        registration_only: true
      },
      gas: '300000000000000',
      attachedDeposit: utils.format.parseNearAmount('0.00125')
    });
    console.log('✅ Storage registered successfully!');

  } catch (error) {
    console.error('❌ Deployment failed:', error.message);
    process.exit(1);
  }

  console.log('🎉 FT contract deployment completed!');
  console.log(`   - Contract: ${contractAccountId}`);
  console.log(`   - Owner: ${signerAccountId}`);
}

main().catch((err) => {
  console.error('❌ Deployment failed:', err);
  process.exit(1);
});