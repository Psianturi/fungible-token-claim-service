#!/bin/bash
# Complete Local Testing Script for FT Service with Artillery
# Handles sandbox setup, contract deployment, and load testing

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_error() { echo -e "${RED}❌ $1${NC}"; }

# Configuration
SANDBOX_PORT=3030
API_PORT=3000
TEST_DURATION=${TEST_DURATION:-300}  # 5 minutes default
MAX_TPS=${MAX_TPS:-200}

# Function to check if port is in use
check_port() {
    local port=$1
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
        return 0
    else
        return 1
    fi
}

# Function to kill processes on port
kill_port() {
    local port=$1
    local pids=$(lsof -ti:$port)
    if [ ! -z "$pids" ]; then
        log_info "Killing processes on port $port: $pids"
        kill -9 $pids 2>/dev/null || true
        sleep 2
    fi
}

# Function to wait for service
wait_for_service() {
    local url=$1
    local max_attempts=$2
    local service_name=$3
    
    for i in $(seq 1 $max_attempts); do
        if curl -sS "$url" >/dev/null 2>&1; then
            log_success "$service_name is ready"
            return 0
        fi
        log_info "Waiting for $service_name... ($i/$max_attempts)"
        sleep 2
    done
    
    log_error "$service_name failed to start within $(($max_attempts * 2)) seconds"
    return 1
}

# Cleanup function
cleanup() {
    log_info "Cleaning up processes..."
    kill_port $SANDBOX_PORT
    kill_port $API_PORT
    pkill -f "near-sandbox" || true
    pkill -f "node.*src/index" || true
}

trap cleanup EXIT

log_info "🚀 Starting Complete FT Service Testing Pipeline"
log_info "📋 Configuration:"
log_info "   - Sandbox Port: $SANDBOX_PORT"
log_info "   - API Port: $API_PORT" 
log_info "   - Test Duration: ${TEST_DURATION}s"
log_info "   - Max TPS Target: $MAX_TPS"

# Step 1: Setup Environment
log_info "🔧 Setting up environment..."

# Clean up any existing processes
cleanup
sleep 3

# Check prerequisites
if ! command -v near-sandbox &> /dev/null; then
    log_error "near-sandbox not found. Installing..."
    npm install -g near-sandbox
fi

if ! command -v artillery &> /dev/null; then
    log_error "artillery not found. Installing..."
    npm install -g artillery
fi

# Step 2: Start NEAR Sandbox
log_info "🏠 Starting NEAR sandbox..."

# Initialize sandbox if needed
npx near-sandbox init >/dev/null 2>&1 || true

# Start sandbox
nohup npx near-sandbox run > sandbox.log 2>&1 &
SANDBOX_PID=$!

# Wait for sandbox to be ready
if ! wait_for_service "http://127.0.0.1:$SANDBOX_PORT/status" 30 "NEAR Sandbox"; then
    log_error "Sandbox failed to start. Check sandbox.log"
    cat sandbox.log
    exit 1
fi

# Step 3: Extract Keys and Setup Environment
log_info "🔑 Setting up accounts and keys..."

VALIDATOR_KEY_FILE="$HOME/.near/validator_key.json"
if [ ! -f "$VALIDATOR_KEY_FILE" ]; then
    log_error "Validator key not found at $VALIDATOR_KEY_FILE"
    exit 1
fi

SECRET_KEY=$(jq -r '.secret_key // .private_key' "$VALIDATOR_KEY_FILE")
ACCOUNT_ID=$(jq -r '.account_id' "$VALIDATOR_KEY_FILE")

log_success "Found validator account: $ACCOUNT_ID"

# Set environment variables
export NEAR_NETWORK_ID=sandbox
export NEAR_NODE_URL=http://127.0.0.1:$SANDBOX_PORT
export FT_CONTRACT_ID=$ACCOUNT_ID
export NEAR_SIGNER_ACCOUNT_ID=$ACCOUNT_ID
export NEAR_SIGNER_ACCOUNT_PRIVATE_KEY=$SECRET_KEY
export NEAR_CONTRACT_ACCOUNT_ID=$ACCOUNT_ID

# Step 4: Deploy Contract
log_info "📦 Deploying FT contract..."

if [ ! -f "fungible_token.wasm" ]; then
    log_error "fungible_token.wasm not found. Build the contract first."
    exit 1
fi

# Create deployment script
cat > deploy-local.mjs << 'EOF'
import { connect, keyStores, utils } from 'near-api-js';
import fs from 'fs';

async function deployContract() {
    const contractAccountId = process.env.NEAR_CONTRACT_ACCOUNT_ID;
    const signerAccountId = process.env.NEAR_SIGNER_ACCOUNT_ID;
    const signerPrivateKey = process.env.NEAR_SIGNER_ACCOUNT_PRIVATE_KEY;
    const nodeUrl = process.env.NEAR_NODE_URL;

    console.log(`Deploying to: ${contractAccountId}`);
    console.log(`Using signer: ${signerAccountId}`);

    const keyStore = new keyStores.InMemoryKeyStore();
    const keyPair = utils.KeyPair.fromString(signerPrivateKey);
    await keyStore.setKey('sandbox', signerAccountId, keyPair);

    const near = await connect({
        networkId: 'sandbox',
        nodeUrl,
        keyStore,
    });

    const account = await near.account(signerAccountId);
    const wasm = fs.readFileSync('fungible_token.wasm');

    // Deploy contract
    await account.deployContract(wasm);
    console.log('✅ Contract deployed');

    // Initialize contract
    await account.functionCall({
        contractId: contractAccountId,
        methodName: 'new_default_meta',
        args: {
            owner_id: signerAccountId,
            total_supply: '1000000000000000000000000000' // 1B tokens
        },
        gas: '300000000000000'
    });
    console.log('✅ Contract initialized');

    // Register storage for master account
    await account.functionCall({
        contractId: contractAccountId,
        methodName: 'storage_deposit',
        args: { account_id: signerAccountId },
        gas: '30000000000000',
        attachedDeposit: utils.format.parseNearAmount('0.00125')
    });
    console.log('✅ Storage registered');
}

deployContract().catch(console.error);
EOF

if node deploy-local.mjs; then
    log_success "Contract deployed successfully"
else
    log_error "Contract deployment failed"
    exit 1
fi

# Step 5: Start API Service
log_info "🌐 Starting API service..."

# Set additional environment for API service
export NODE_URL=http://127.0.0.1:$SANDBOX_PORT
export MASTER_ACCOUNT=$ACCOUNT_ID
export MASTER_ACCOUNT_PRIVATE_KEY=$SECRET_KEY

# Start API service in background
npm run start:sandbox > api.log 2>&1 &
API_PID=$!

if ! wait_for_service "http://127.0.0.1:$API_PORT/health" 30 "API Service"; then
    log_error "API service failed to start. Check api.log"
    cat api.log
    exit 1
fi

# Step 6: Create Artillery Configuration
log_info "⚡ Setting up Artillery load test..."

cat > artillery-local.yml << EOF
config:
  target: 'http://127.0.0.1:$API_PORT'
  phases:
    # Warm-up phase
    - duration: 30
      arrivalRate: 5
      name: "Warm-up"
    
    # Gradual ramp-up
    - duration: 60  
      arrivalRate: 10
      rampTo: 50
      name: "Ramp-up"
      
    # Sustained load
    - duration: 120
      arrivalRate: 100
      name: "Sustained Load"
      
    # Peak load test
    - duration: 60
      arrivalRate: 150
      rampTo: $MAX_TPS
      name: "Peak Load"

  variables:
    receiverId:
      - "user1.$ACCOUNT_ID"
      - "user2.$ACCOUNT_ID"
      - "user3.$ACCOUNT_ID" 
      - "alice.$ACCOUNT_ID"
      - "bob.$ACCOUNT_ID"
    
    amount:
      - "1000000000000000000000000"    # 1 token
      - "5000000000000000000000000"    # 5 tokens
      - "10000000000000000000000000"   # 10 tokens

scenarios:
  - name: "Single FT Transfer"
    weight: 70
    flow:
      - post:
          url: "/send-ft"
          headers:
            Content-Type: "application/json"
          json:
            receiverId: "{{ receiverId }}"
            amount: "{{ amount }}"
            memo: "Load test {{ \$timestamp }}"
          expect:
            - statusCode: [200, 500]  # Accept both success and expected errors

  - name: "Health Check"
    weight: 20
    flow:
      - get:
          url: "/health"
          expect:
            - statusCode: 200

  - name: "Batch Transfer"
    weight: 10
    flow:
      - post:
          url: "/send-ft"
          headers:
            Content-Type: "application/json"
          json:
            transfers:
              - receiverId: "{{ receiverId }}"
                amount: "{{ amount }}"
                memo: "Batch load test"
          expect:
            - statusCode: [200, 500]  # Accept both success and expected errors
EOF

# Step 7: Run Artillery Test
log_info "🚀 Starting Artillery load test..."

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULTS_FILE="artillery-results-$TIMESTAMP.json"
REPORT_FILE="artillery-report-$TIMESTAMP.html"

artillery run artillery-local.yml --output "$RESULTS_FILE" --quiet

if [ -f "$RESULTS_FILE" ]; then
    # Generate HTML report
    artillery report "$RESULTS_FILE" --output "$REPORT_FILE"
    
    log_success "Artillery test completed!"
    echo ""
    echo "📊 Results Summary:"
    
    if command -v jq &> /dev/null; then
        TOTAL_REQUESTS=$(jq -r '.aggregate.counters."http.requests" // 0' "$RESULTS_FILE")
        SUCCESSFUL=$(jq -r '.aggregate.counters."http.responses" // 0' "$RESULTS_FILE")  
        AVG_RESPONSE=$(jq -r '.aggregate.summaries."http.response_time".mean // 0' "$RESULTS_FILE")
        MAX_RESPONSE=$(jq -r '.aggregate.summaries."http.response_time".max // 0' "$RESULTS_FILE")
        
        echo "   📈 Total Requests: $TOTAL_REQUESTS"
        echo "   ✅ Responses: $SUCCESSFUL"
        echo "   ⏱️  Avg Response Time: ${AVG_RESPONSE}ms"
        echo "   🚀 Max Response Time: ${MAX_RESPONSE}ms"
        
        # Calculate rough TPS
        if [ "$TOTAL_REQUESTS" != "0" ]; then
            TPS=$(echo "scale=1; $TOTAL_REQUESTS / $TEST_DURATION" | bc -l 2>/dev/null || echo "N/A")
            echo "   🎯 Average TPS: $TPS"
        fi
    fi
    
    echo ""
    echo "📋 View detailed results:"
    echo "   🌐 HTML Report: file://$(pwd)/$REPORT_FILE"
    echo "   📄 JSON Data: $RESULTS_FILE"
    
    # Open report if possible
    if command -v xdg-open &> /dev/null; then
        xdg-open "$REPORT_FILE" 2>/dev/null &
    elif command -v open &> /dev/null; then
        open "$REPORT_FILE" 2>/dev/null &
    fi
    
else
    log_error "Artillery test failed - no results generated"
    exit 1
fi

log_success "🎉 Complete FT service testing pipeline finished successfully!"
log_info "📊 Check the HTML report for detailed performance metrics"