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
  const nodeUrl = process.env.NEAR_NODE_URL || 'http://127.0.0.1:3030';

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
    keyPair = utils.KeyPair.fromString(signerPrivateKey);
  } catch (error) {
    console.log('Failed to parse key with prefix, trying without prefix...');
    const keyWithoutPrefix = signerPrivateKey.replace(/^ed25519:/, '');
    keyPair = utils.KeyPair.fromString(keyWithoutPrefix);
  }
  await keyStore.setKey(networkConnection, signerAccountId, keyPair);

  // Connect to NEAR
  const near = await connect({
    networkId: networkConnection,
    keyStore,
    nodeUrl,
  });

  // Get account handle
  const signerAccount = await near.account(signerAccountId);

  // Ensure contract account exists (allowing contract == signer)
  let contractAccount;
  if (contractAccountId === signerAccountId) {
    contractAccount = signerAccount;
    console.log('✅ Using signer account as contract account');
  } else {
    try {
      contractAccount = await near.account(contractAccountId);
      console.log('✅ Found existing contract account:', contractAccountId);
    } catch (error) {
      console.log('ℹ️  Contract account missing, creating sub-account...');
      const publicKey = keyPair.getPublicKey();
      await signerAccount.createAccount(
        contractAccountId,
        publicKey,
        utils.format.parseNearAmount('10')
      );
      contractAccount = await near.account(contractAccountId);
      console.log('✅ Created contract sub-account:', contractAccountId);
    }
    await keyStore.setKey(networkConnection, contractAccountId, keyPair);
  }

  // Read WASM file
  const wasm = fs.readFileSync(wasmPath);
  console.log(`📄 WASM file size: ${wasm.length} bytes`);

  try {
    // Deploy contract using the standard near-api-js approach
    console.log('🔨 Deploying contract...');
    await contractAccount.deployContract(wasm);
    console.log('✅ Contract deployed successfully!');

    // Initialize contract using the same pattern as near-ft-helper
    console.log('⚙️ Initializing contract...');
    await contractAccount.functionCall({
      contractId: contractAccountId,
      methodName: 'new_default_meta',
      args: {
        owner_id: signerAccountId,
        total_supply: '1000000000000000000000000'
      },
      gas: '30000000000000'
    });
    console.log('✅ Contract initialized successfully!');

    // Register storage for signer account
    console.log('💾 Registering storage...');
    await contractAccount.functionCall({
      contractId: contractAccountId,
      methodName: 'storage_deposit',
      args: {
        account_id: signerAccountId,
        registration_only: true
      },
      gas: '30000000000000',
      attachedDeposit: utils.format.parseNearAmount('0.00125')
    });
    console.log('✅ Storage registered successfully!');

  } catch (error) {
    const message = error?.message || String(error);
    if (message.includes('contract has already been initialized')) {
      console.log('⚠️ Contract already initialized, continuing...');
    } else {
      console.error('❌ Deployment failed:', message);
      process.exit(1);
    }
  }

  console.log('🎉 FT contract deployment completed!');
  console.log(`   - Contract: ${contractAccountId}`);
  console.log(`   - Owner: ${signerAccountId}`);
}

main().catch((err) => {
  console.error('❌ Deployment failed:', err);
  process.exit(1);
});