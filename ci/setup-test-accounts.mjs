/**
 * Setup test accounts for CI integration testing
 *
 * Required env:
 *   - NEAR_CONTRACT_ACCOUNT_ID (FT contract account)
 *   - NEAR_SIGNER_ACCOUNT_ID (master account)
 *   - NEAR_SIGNER_ACCOUNT_PRIVATE_KEY (master account private key)
 *   - NEAR_NETWORK_CONNECTION (sandbox)
 */
import { connect, keyStores, utils } from 'near-api-js';

async function main() {
  console.log('👥 Setting up test accounts for CI...');

  // Load environment variables
  const contractAccountId = process.env.NEAR_CONTRACT_ACCOUNT_ID || 'ft.test.near';
  const signerAccountId = process.env.NEAR_SIGNER_ACCOUNT_ID || 'test.near';
  const signerPrivateKey = process.env.NEAR_SIGNER_ACCOUNT_PRIVATE_KEY;
  const networkConnection = process.env.NEAR_NETWORK_CONNECTION || 'sandbox';
  const nodeUrl = process.env.NEAR_NODE_URL || 'http://127.0.0.1:3030';

  if (!contractAccountId || !signerAccountId || !signerPrivateKey) {
    throw new Error('Missing required environment variables');
  }

  console.log(`📦 Contract: ${contractAccountId}`);
  console.log(`🔑 Signer: ${signerAccountId}`);

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
    nodeUrl,
    deps: { keyStore },
  });

  // Get master account
  const masterAccount = await near.account(signerAccountId);

  // Create or reuse test user account
  console.log('Creating test user account...');
  const userAccountId = `user.${signerAccountId}`;
  let userAccount;
  try {
    userAccount = await near.account(userAccountId);
    console.log('✅ User account already exists:', userAccountId);
  } catch (_) {
    const userKeyPair = utils.KeyPair.fromRandom('ed25519');
    await keyStore.setKey(networkConnection, userAccountId, userKeyPair);
    await masterAccount.createAccount(
      userAccountId,
      userKeyPair.getPublicKey(),
      utils.format.parseNearAmount('5')
    );
    userAccount = await near.account(userAccountId);
    console.log('✅ Created user account:', userAccount.accountId);
  }

  // Register storage for user account
  console.log('Registering storage for user account...');
  try {
    await masterAccount.functionCall({
      contractId: contractAccountId,
      methodName: 'storage_deposit',
      args: { account_id: userAccount.accountId, registration_only: true },
      gas: '30000000000000',
      attachedDeposit: utils.format.parseNearAmount('0.00125')
    });
    console.log('✅ Storage registered for user account');
  } catch (error) {
    const message = error?.message || String(error);
    if (message.includes('already registered')) {
      console.log('⚠️ Storage already registered, continuing...');
    } else {
      console.log('⚠️ Storage registration may have failed:', message);
    }
  }

  // Output the user account ID for GitHub Actions
  console.log('USER_ACCOUNT_ID=' + userAccount.accountId);
}

main().catch((err) => {
  console.error('❌ Test account setup failed:', err);
  process.exit(1);
});