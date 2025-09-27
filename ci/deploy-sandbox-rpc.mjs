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
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function patchBorshSchemas() {
  try {
    const nearTransactions = require('near-api-js/lib/transaction.js');
    const nearCrypto = require('near-api-js/lib/utils/key_pair.js');

    const accountsSchemaModule = require('@near-js/accounts/node_modules/@near-js/transactions/lib/schema.js');
    const accountsActionsModule = require('@near-js/accounts/node_modules/@near-js/transactions/lib/actions.js');
    const accountsSignatureModule = require('@near-js/accounts/node_modules/@near-js/transactions/lib/signature.js');
    const accountsCryptoModule = require('@near-js/accounts/node_modules/@near-js/crypto/lib/public_key.js');
    const providersSchemaModule = require('@near-js/providers/node_modules/@near-js/transactions/lib/schema.js');
    const providersActionsModule = require('@near-js/providers/node_modules/@near-js/transactions/lib/actions.js');
    const providersSignatureModule = require('@near-js/providers/node_modules/@near-js/transactions/lib/signature.js');
    const providersCryptoModule = require('@near-js/providers/node_modules/@near-js/crypto/lib/public_key.js');

    const modulesToPatch = [
      { name: '@near-js/accounts', schemaModule: accountsSchemaModule, actionsModule: accountsActionsModule, signatureModule: accountsSignatureModule, cryptoModule: accountsCryptoModule },
      { name: '@near-js/providers', schemaModule: providersSchemaModule, actionsModule: providersActionsModule, signatureModule: providersSignatureModule, cryptoModule: providersCryptoModule },
    ];

    const classKeys = [
      'SignedTransaction',
      'Transaction',
      'AccessKey',
      'AccessKeyPermission',
      'FunctionCallPermission',
      'FullAccessPermission',
      'FunctionCall',
      'Transfer',
      'Stake',
      'AddKey',
      'DeleteKey',
      'DeleteAccount',
      'CreateAccount',
      'DeployContract',
      'SignedDelegate',
      'DelegateAction',
      'Signature',
      'Action',
      'PublicKey',
    ];

    const schemaSources = [
      { label: 'near-api-js', transactions: nearTransactions, actions: nearTransactions, signature: nearTransactions, crypto: nearCrypto },
      { label: '@near-js/accounts', transactions: accountsSchemaModule, actions: accountsActionsModule, signature: accountsSignatureModule, crypto: accountsCryptoModule },
      { label: '@near-js/providers', transactions: providersSchemaModule, actions: providersActionsModule, signature: providersSignatureModule, crypto: providersCryptoModule },
    ];

    const getClass = (container, key) => container?.[key];

    for (const { name, schemaModule, actionsModule, signatureModule, cryptoModule } of modulesToPatch) {
      const { SCHEMA } = schemaModule || {};
      if (!SCHEMA || typeof SCHEMA.has !== 'function' || typeof SCHEMA.get !== 'function' || typeof SCHEMA.set !== 'function') {
        continue;
      }

      for (const key of classKeys) {
        const canonicalClass =
          getClass(schemaModule, key) ||
          getClass(actionsModule, key) ||
          getClass(signatureModule, key) ||
          getClass(cryptoModule, key);
        if (!canonicalClass || !SCHEMA.has(canonicalClass)) {
          continue;
        }

        for (const source of schemaSources) {
          const candidate =
            getClass(source.transactions, key) ||
            getClass(source.actions, key) ||
            getClass(source.signature, key) ||
            getClass(source.crypto, key);
          if (!candidate || candidate === canonicalClass || SCHEMA.has(candidate)) {
            continue;
          }
          SCHEMA.set(candidate, SCHEMA.get(canonicalClass));
          console.log(`🩹 Patched ${name} schema for ${key} via ${source.label}`);
        }
      }

      const canonicalPublicKey = cryptoModule?.PublicKey;
      if (canonicalPublicKey && SCHEMA.has(canonicalPublicKey)) {
        for (const source of schemaSources) {
          const candidatePk = source.crypto?.PublicKey;
          if (!candidatePk || candidatePk === canonicalPublicKey || SCHEMA.has(candidatePk)) {
            continue;
          }
          SCHEMA.set(candidatePk, SCHEMA.get(canonicalPublicKey));
          console.log(`🩹 Patched ${name} schema for PublicKey via ${source.label}`);
        }
      }

      const canonicalSignature =
        getClass(schemaModule, 'Signature') ||
        getClass(signatureModule, 'Signature') ||
        getClass(cryptoModule, 'Signature');
      if (canonicalSignature && SCHEMA.has(canonicalSignature)) {
        for (const source of schemaSources) {
          const candidateSig =
            getClass(source.signature, 'Signature') ||
            getClass(source.transactions, 'Signature') ||
            getClass(source.actions, 'Signature') ||
            getClass(source.crypto, 'Signature');
          if (!candidateSig || candidateSig === canonicalSignature || SCHEMA.has(candidateSig)) {
            continue;
          }
          SCHEMA.set(candidateSig, SCHEMA.get(canonicalSignature));
          console.log(`🩹 Patched ${name} schema for Signature via ${source.label}`);
        }
      }
    }
  } catch (error) {
    console.log('⚠️ Failed to patch borsh schemas:', error?.message || error);
  }
}

async function main() {
  console.log('🚀 Deploy script started...');

  // Load environment variables
  const contractAccountId = process.env.NEAR_CONTRACT_ACCOUNT_ID || 'test.near';
  const signerAccountId = process.env.NEAR_SIGNER_ACCOUNT_ID || 'test.near';
  const signerPrivateKey = process.env.NEAR_SIGNER_ACCOUNT_PRIVATE_KEY;

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

  // Setup key store with simplified approach (like near-ft-claiming-service)
  const keyStore = new keyStores.InMemoryKeyStore();
  const keyPair = utils.KeyPair.fromString(signerPrivateKey);
  await keyStore.setKey('sandbox', signerAccountId, keyPair);

  // Connect to NEAR
  const near = await connect({
    networkId: 'sandbox',
    nodeUrl: 'http://127.0.0.1:3030',
    deps: { keyStore },
  });

  // Get account handle
  const account = await near.account(signerAccountId);

  // Read WASM file
  const wasm = fs.readFileSync(wasmPath);
  console.log(`📄 WASM file size: ${wasm.length} bytes`);

  try {
    // Deploy contract using simplified approach
    console.log('🔨 Deploying contract...');
    await account.deployContract(wasm);
    console.log('✅ Contract deployed successfully!');

    // Initialize contract with minimal parameters (like near-ft-claiming-service)
    console.log('⚙️ Initializing contract...');
    await account.functionCall({
      contractId: contractAccountId,
      methodName: 'new_default_meta',
      args: {
        owner_id: signerAccountId,
        total_supply: '1000000000000000000000000' // 1M tokens with 18 decimals
      },
      gas: '300000000000000', // 300 TGas
      attachedDeposit: '0'
    });
    console.log('✅ Contract initialized successfully!');

  } catch (error) {
    const message = error?.message || String(error);
    console.error('❌ Deployment failed:', message);
    throw error;
  }

  console.log('🎉 FT contract deployment completed!');
  console.log(`   - Contract: ${contractAccountId}`);
  console.log(`   - Owner: ${signerAccountId}`);
}

main().catch((err) => {
  console.error('❌ Deployment failed:', err);
  process.exit(1);
});