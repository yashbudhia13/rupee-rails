# erupee-utxo: Hyperledger Fabric chaincode

The on-ledger counterpart of `src/ledger.ts`, written as Fabric chaincode in Go. Same
token model (UTXOs in standard denominations), same purpose-bound rules (MCC allowlist,
expiry, geofence), same conservation invariant, expressed as a smart contract that a
permissioned network of the central bank and its banks would endorse.

RBI's e₹ core is reported to run on a permissioned DLT of this kind. This module shows what
the token logic looks like when the ledger is a Fabric channel instead of a single operator:

- Identity comes from the caller's X.509 certificate. `Mint`, `Burn`, `Issue`, `SetReserve`
  and `SweepExpired` require the `RBIMSP` membership; everything else is any member.
- Tokens are world-state entries keyed `utxo~<id>`; spending deletes the input and writes
  the outputs, exactly like `fabric-samples/token-utxo`. Ids are `<txID>.<index>`, so they
  are deterministic per transaction.
- `Transfer(inputs, outputs, context)` enforces balance, ownership, rule inheritance on
  change, rule release on a qualifying merchant spend, and refuses mixing or re-binding.
- `Supply()` reports minted, burned and unspent, and whether they reconcile.

## Test

```sh
cd chaincode/erupee-utxo
go test ./...
```

The tests run the contract against a hand-written mock of the Fabric stub and client
identity (`mocks_test.go`), covering minting rights, reserves, balance and ownership checks,
double-spend refusal, the full purpose-bound flow including expiry and sweep, redeem and
burn, and deterministic ids.

## Deploy on the Fabric test network

Not exercised in this repository's CI (it needs Docker). With
[fabric-samples](https://github.com/hyperledger/fabric-samples) checked out:

```sh
cd fabric-samples/test-network
./network.sh up createChannel -ca
./network.sh deployCC -ccn erupee -ccp /path/to/rupee-rails/chaincode/erupee-utxo -ccl go
# Then, as Org1 (standing in for the central bank; rename its MSP to RBIMSP or edit CentralBankMSP):
peer chaincode invoke ... -c '{"function":"Mint","Args":["100000000"]}'
```

## Not in scope

- No offline vouchers: those are a device-and-bank concern, not a ledger concern.
- No owner index: `UTXOsOf` scans all tokens. A production contract would keep a
  composite-key index per owner or use CouchDB rich queries.
- No endorsement policy tuning, private data collections or channel design; those are
  network decisions, not contract code.
