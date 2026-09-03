// Package main is Hyperledger Fabric chaincode for an e₹-style UTXO token.
//
// It is the on-ledger counterpart of src/ledger.ts: the same token model,
// denominations, purpose-bound rules and conservation invariant, expressed as
// a smart contract that a permissioned network of banks and the central bank
// would endorse. Identity comes from the caller's X.509 certificate: the
// central bank is whoever belongs to CentralBankMSP.
//
// State layout (world state):
//
//	utxo~<id>          -> UTXO   (unspent outputs; spent ones are deleted)
//	merchant~<owner>   -> MCC    (merchant category registry, for rule checks)
//	reserve~<owner>    -> int64  (a bank's reserve account at the central bank)
//	supply             -> Supply (minted and burned totals)
//	rbi                -> string (the central bank's client id, set on first mint)
package main

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

// CentralBankMSP is the membership service provider that may mint, issue and burn.
const CentralBankMSP = "RBIMSP"

const (
	utxoType     = "utxo"
	merchantType = "merchant"
	reserveType  = "reserve"
	supplyKey    = "supply"
	rbiKey       = "rbi"
	smallestUnit = 50
)

// Denominations in paise, largest first. Greedy change-making is exact for this set.
var Denominations = []int64{50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50}

type GeoFence struct {
	Lat     float64 `json:"lat"`
	Lng     float64 `json:"lng"`
	RadiusM float64 `json:"radiusM"`
}

// Rules make a token purpose-bound. They travel with the token; change inherits them.
type Rules struct {
	Purpose      string    `json:"purpose"`
	ReturnTo     string    `json:"returnTo"`
	MccAllowlist []string  `json:"mccAllowlist,omitempty"`
	ExpiresAt    string    `json:"expiresAt,omitempty"`
	Geofence     *GeoFence `json:"geofence,omitempty"`
}

type UTXO struct {
	ID        string `json:"id"`
	Owner     string `json:"owner"`
	Amount    int64  `json:"amount"`
	Rules     *Rules `json:"rules,omitempty"`
	CreatedBy string `json:"createdBy"`
}

type Output struct {
	Owner  string `json:"owner"`
	Amount int64  `json:"amount"`
	Rules  *Rules `json:"rules,omitempty"`
}

type Location struct {
	Lat float64 `json:"lat"`
	Lng float64 `json:"lng"`
}

type SpendContext struct {
	Location *Location `json:"location,omitempty"`
}

type Supply struct {
	Minted int64 `json:"minted"`
	Burned int64 `json:"burned"`
}

type SupplyReport struct {
	Minted  int64 `json:"minted"`
	Burned  int64 `json:"burned"`
	Unspent int64 `json:"unspent"`
	Ok      bool  `json:"ok"`
}

// SmartContract is the e₹ UTXO contract.
type SmartContract struct {
	contractapi.Contract
}

// ---------------------------------------------------------------- central bank

// Mint creates new tokens owned by the central bank. Central bank only.
func (s *SmartContract) Mint(ctx contractapi.TransactionContextInterface, amount int64) ([]UTXO, error) {
	if err := requireMSP(ctx, CentralBankMSP); err != nil {
		return nil, err
	}
	if err := assertPaise(amount); err != nil {
		return nil, err
	}
	owner, err := ctx.GetClientIdentity().GetID()
	if err != nil {
		return nil, err
	}
	stub := ctx.GetStub()
	if err := stub.PutState(rbiKey, []byte(owner)); err != nil {
		return nil, err
	}
	created, err := createTokens(ctx, owner, amount, nil, stub.GetTxID(), 0)
	if err != nil {
		return nil, err
	}
	supply, err := readSupply(ctx)
	if err != nil {
		return nil, err
	}
	supply.Minted += amount
	return created, writeSupply(ctx, supply)
}

// Burn destroys central-bank-held tokens. Central bank only.
func (s *SmartContract) Burn(ctx contractapi.TransactionContextInterface, inputsJSON string) (int64, error) {
	if err := requireMSP(ctx, CentralBankMSP); err != nil {
		return 0, err
	}
	caller, err := ctx.GetClientIdentity().GetID()
	if err != nil {
		return 0, err
	}
	inputs, err := loadInputs(ctx, inputsJSON, caller)
	if err != nil {
		return 0, err
	}
	var total int64
	for _, in := range inputs {
		total += in.Amount
		if err := spend(ctx, in); err != nil {
			return 0, err
		}
	}
	supply, err := readSupply(ctx)
	if err != nil {
		return 0, err
	}
	supply.Burned += total
	return total, writeSupply(ctx, supply)
}

// SetReserve records a bank's reserve balance at the central bank. Central bank only.
func (s *SmartContract) SetReserve(ctx contractapi.TransactionContextInterface, bankOwner string, amount int64) error {
	if err := requireMSP(ctx, CentralBankMSP); err != nil {
		return err
	}
	if amount < 0 {
		return fmt.Errorf("reserve cannot be negative")
	}
	return writeReserve(ctx, bankOwner, amount)
}

// Reserve returns a bank's reserve balance.
func (s *SmartContract) Reserve(ctx contractapi.TransactionContextInterface, bankOwner string) (int64, error) {
	return readReserve(ctx, bankOwner)
}

// Issue moves tokens from the central bank to a bank, debiting the bank's reserve. Central bank only.
func (s *SmartContract) Issue(ctx contractapi.TransactionContextInterface, bankOwner string, amount int64) ([]UTXO, error) {
	if err := requireMSP(ctx, CentralBankMSP); err != nil {
		return nil, err
	}
	if err := assertPaise(amount); err != nil {
		return nil, err
	}
	reserve, err := readReserve(ctx, bankOwner)
	if err != nil {
		return nil, err
	}
	if reserve < amount {
		return nil, fmt.Errorf("INSUFFICIENT_RESERVE: %d < %d", reserve, amount)
	}
	rbi, err := ctx.GetClientIdentity().GetID()
	if err != nil {
		return nil, err
	}
	inputs, err := selectInputs(ctx, rbi, amount, func(u UTXO) bool { return u.Rules == nil })
	if err != nil {
		return nil, err
	}
	var total int64
	for _, in := range inputs {
		total += in.Amount
		if err := spend(ctx, in); err != nil {
			return nil, err
		}
	}
	txID := ctx.GetStub().GetTxID()
	created, err := createTokens(ctx, bankOwner, amount, nil, txID, 0)
	if err != nil {
		return nil, err
	}
	if change := total - amount; change > 0 {
		if _, err := createTokens(ctx, rbi, change, nil, txID, len(created)); err != nil {
			return nil, err
		}
	}
	return created, writeReserve(ctx, bankOwner, reserve-amount)
}

// Redeem returns a bank's tokens to the central bank, crediting the bank's reserve.
func (s *SmartContract) Redeem(ctx contractapi.TransactionContextInterface, inputsJSON string) (int64, error) {
	caller, err := ctx.GetClientIdentity().GetID()
	if err != nil {
		return 0, err
	}
	rbiBytes, err := ctx.GetStub().GetState(rbiKey)
	if err != nil {
		return 0, err
	}
	if len(rbiBytes) == 0 {
		return 0, fmt.Errorf("nothing minted yet")
	}
	inputs, err := loadInputs(ctx, inputsJSON, caller)
	if err != nil {
		return 0, err
	}
	var total int64
	for _, in := range inputs {
		if in.Rules != nil {
			return 0, fmt.Errorf("RULES_NOT_ALLOWED: cannot redeem purpose-bound tokens")
		}
		total += in.Amount
		if err := spend(ctx, in); err != nil {
			return 0, err
		}
	}
	if _, err := createTokens(ctx, string(rbiBytes), total, nil, ctx.GetStub().GetTxID(), 0); err != nil {
		return 0, err
	}
	reserve, err := readReserve(ctx, caller)
	if err != nil {
		return 0, err
	}
	return total, writeReserve(ctx, caller, reserve+total)
}

// SweepExpired returns expired purpose-bound tokens to their scheme owner. Central bank only.
func (s *SmartContract) SweepExpired(ctx contractapi.TransactionContextInterface) ([]UTXO, error) {
	if err := requireMSP(ctx, CentralBankMSP); err != nil {
		return nil, err
	}
	now, err := txTime(ctx)
	if err != nil {
		return nil, err
	}
	all, err := allUTXOs(ctx)
	if err != nil {
		return nil, err
	}
	byScheme := map[string]int64{}
	var swept []UTXO
	for _, u := range all {
		if u.Rules != nil && isExpired(u.Rules, now) {
			if err := spend(ctx, u); err != nil {
				return nil, err
			}
			byScheme[u.Rules.ReturnTo] += u.Amount
			swept = append(swept, u)
		}
	}
	owners := make([]string, 0, len(byScheme))
	for o := range byScheme {
		owners = append(owners, o)
	}
	sort.Strings(owners)
	index := 0
	for _, o := range owners {
		created, err := createTokens(ctx, o, byScheme[o], nil, ctx.GetStub().GetTxID(), index)
		if err != nil {
			return nil, err
		}
		index += len(created)
	}
	return swept, nil
}

// ------------------------------------------------------------------ everyone

// RegisterMerchant records a merchant's category code so purpose-bound spends can be checked.
func (s *SmartContract) RegisterMerchant(ctx contractapi.TransactionContextInterface, owner string, mcc string) error {
	if len(mcc) != 4 {
		return fmt.Errorf("mcc must be four digits")
	}
	key, err := ctx.GetStub().CreateCompositeKey(merchantType, []string{owner})
	if err != nil {
		return err
	}
	return ctx.GetStub().PutState(key, []byte(mcc))
}

// Transfer spends the caller's inputs into new outputs. Inputs and outputs must balance.
// Purpose-bound inputs are checked against the recipient's MCC, the transaction time and
// the optional location in contextJSON; change keeps the rules, qualifying recipients get
// ordinary tokens, and rules can only be attached when spending unrestricted inputs.
func (s *SmartContract) Transfer(ctx contractapi.TransactionContextInterface, inputsJSON string, outputsJSON string, contextJSON string) ([]UTXO, error) {
	caller, err := ctx.GetClientIdentity().GetID()
	if err != nil {
		return nil, err
	}
	var outputs []Output
	if err := json.Unmarshal([]byte(outputsJSON), &outputs); err != nil {
		return nil, fmt.Errorf("outputs: %w", err)
	}
	if len(outputs) == 0 {
		return nil, fmt.Errorf("INVALID_OUTPUT: transfer needs at least one output")
	}
	var spendCtx SpendContext
	if contextJSON != "" {
		if err := json.Unmarshal([]byte(contextJSON), &spendCtx); err != nil {
			return nil, fmt.Errorf("context: %w", err)
		}
	}
	inputs, err := loadInputs(ctx, inputsJSON, caller)
	if err != nil {
		return nil, err
	}
	var inTotal, outTotal int64
	for _, in := range inputs {
		inTotal += in.Amount
	}
	for _, o := range outputs {
		if err := assertPaise(o.Amount); err != nil {
			return nil, err
		}
		if o.Owner == "" {
			return nil, fmt.Errorf("INVALID_OUTPUT: output owner is required")
		}
		outTotal += o.Amount
	}
	if inTotal != outTotal {
		return nil, fmt.Errorf("UNBALANCED: inputs %d != outputs %d", inTotal, outTotal)
	}

	inputRules := inputs[0].Rules
	for _, in := range inputs[1:] {
		if !sameRules(in.Rules, inputRules) {
			return nil, fmt.Errorf("MIXED_RULES: inputs must all carry the same rules (or none)")
		}
	}
	now, err := txTime(ctx)
	if err != nil {
		return nil, err
	}

	final := make([]Output, 0, len(outputs))
	for _, o := range outputs {
		if inputRules != nil {
			if o.Rules != nil {
				return nil, fmt.Errorf("RULES_NOT_ALLOWED: purpose-bound tokens cannot be re-bound")
			}
			if o.Owner == caller {
				final = append(final, Output{Owner: o.Owner, Amount: o.Amount, Rules: inputRules})
				continue
			}
			mcc, err := merchantMCC(ctx, o.Owner)
			if err != nil {
				return nil, err
			}
			if v := evaluateRules(inputRules, now, mcc, spendCtx.Location); v != "" {
				return nil, fmt.Errorf("RULE_VIOLATION: %s", v)
			}
			final = append(final, Output{Owner: o.Owner, Amount: o.Amount})
		} else {
			if o.Rules != nil {
				if err := validateRules(o.Rules); err != nil {
					return nil, err
				}
			}
			final = append(final, o)
		}
	}

	txID := ctx.GetStub().GetTxID()
	for _, in := range inputs {
		if err := spend(ctx, in); err != nil {
			return nil, err
		}
	}
	var created []UTXO
	for _, o := range final {
		tokens, err := createTokens(ctx, o.Owner, o.Amount, o.Rules, txID, len(created))
		if err != nil {
			return nil, err
		}
		created = append(created, tokens...)
	}
	return created, nil
}

// ClientUTXOs lists the caller's unspent tokens.
func (s *SmartContract) ClientUTXOs(ctx contractapi.TransactionContextInterface) ([]UTXO, error) {
	caller, err := ctx.GetClientIdentity().GetID()
	if err != nil {
		return nil, err
	}
	return s.UTXOsOf(ctx, caller)
}

// UTXOsOf lists an owner's unspent tokens. A production contract would keep an owner index
// or use a rich query; a full scan is fine for a sandbox and keeps the state layout obvious.
func (s *SmartContract) UTXOsOf(ctx contractapi.TransactionContextInterface, owner string) ([]UTXO, error) {
	all, err := allUTXOs(ctx)
	if err != nil {
		return nil, err
	}
	out := []UTXO{}
	for _, u := range all {
		if u.Owner == owner {
			out = append(out, u)
		}
	}
	return out, nil
}

// Supply reports minted, burned and unspent totals, and whether conservation holds.
func (s *SmartContract) Supply(ctx contractapi.TransactionContextInterface) (*SupplyReport, error) {
	supply, err := readSupply(ctx)
	if err != nil {
		return nil, err
	}
	all, err := allUTXOs(ctx)
	if err != nil {
		return nil, err
	}
	var unspent int64
	for _, u := range all {
		unspent += u.Amount
	}
	return &SupplyReport{Minted: supply.Minted, Burned: supply.Burned, Unspent: unspent, Ok: unspent == supply.Minted-supply.Burned}, nil
}

// ------------------------------------------------------------------ internals

func requireMSP(ctx contractapi.TransactionContextInterface, msp string) error {
	got, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return err
	}
	if got != msp {
		return fmt.Errorf("FORBIDDEN: %s required, caller is %s", msp, got)
	}
	return nil
}

func assertPaise(amount int64) error {
	if amount <= 0 {
		return fmt.Errorf("INVALID_AMOUNT: amount must be positive, got %d", amount)
	}
	if amount%smallestUnit != 0 {
		return fmt.Errorf("INVALID_AMOUNT: amount must be a multiple of %d paise, got %d", smallestUnit, amount)
	}
	return nil
}

func denominate(amount int64) []int64 {
	var out []int64
	remaining := amount
	for _, d := range Denominations {
		for remaining >= d {
			out = append(out, d)
			remaining -= d
		}
	}
	return out
}

func utxoKey(ctx contractapi.TransactionContextInterface, id string) (string, error) {
	return ctx.GetStub().CreateCompositeKey(utxoType, []string{id})
}

func createTokens(ctx contractapi.TransactionContextInterface, owner string, amount int64, rules *Rules, txID string, startIndex int) ([]UTXO, error) {
	var created []UTXO
	for i, d := range denominate(amount) {
		u := UTXO{ID: txID + "." + strconv.Itoa(startIndex+i), Owner: owner, Amount: d, Rules: rules, CreatedBy: txID}
		key, err := utxoKey(ctx, u.ID)
		if err != nil {
			return nil, err
		}
		existing, err := ctx.GetStub().GetState(key)
		if err != nil {
			return nil, err
		}
		if len(existing) > 0 {
			return nil, fmt.Errorf("token %s already exists", u.ID)
		}
		data, err := json.Marshal(u)
		if err != nil {
			return nil, err
		}
		if err := ctx.GetStub().PutState(key, data); err != nil {
			return nil, err
		}
		created = append(created, u)
	}
	return created, nil
}

func loadInputs(ctx contractapi.TransactionContextInterface, inputsJSON string, requiredOwner string) ([]UTXO, error) {
	var ids []string
	if err := json.Unmarshal([]byte(inputsJSON), &ids); err != nil {
		return nil, fmt.Errorf("inputs: %w", err)
	}
	if len(ids) == 0 {
		return nil, fmt.Errorf("INVALID_OUTPUT: transfer needs at least one input")
	}
	seen := map[string]bool{}
	var out []UTXO
	for _, id := range ids {
		if seen[id] {
			return nil, fmt.Errorf("ALREADY_SPENT: duplicate input %s", id)
		}
		seen[id] = true
		key, err := utxoKey(ctx, id)
		if err != nil {
			return nil, err
		}
		data, err := ctx.GetStub().GetState(key)
		if err != nil {
			return nil, err
		}
		if len(data) == 0 {
			return nil, fmt.Errorf("UNKNOWN_TOKEN: %s is unknown or already spent", id)
		}
		var u UTXO
		if err := json.Unmarshal(data, &u); err != nil {
			return nil, err
		}
		if u.Owner != requiredOwner {
			return nil, fmt.Errorf("NOT_OWNER: %s is not owned by the caller", id)
		}
		out = append(out, u)
	}
	return out, nil
}

func spend(ctx contractapi.TransactionContextInterface, u UTXO) error {
	key, err := utxoKey(ctx, u.ID)
	if err != nil {
		return err
	}
	return ctx.GetStub().DelState(key)
}

func selectInputs(ctx contractapi.TransactionContextInterface, owner string, amount int64, filter func(UTXO) bool) ([]UTXO, error) {
	all, err := allUTXOs(ctx)
	if err != nil {
		return nil, err
	}
	var candidates []UTXO
	for _, u := range all {
		if u.Owner == owner && filter(u) {
			candidates = append(candidates, u)
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].Amount > candidates[j].Amount })
	var chosen []UTXO
	var total int64
	for _, u := range candidates {
		if total >= amount {
			break
		}
		chosen = append(chosen, u)
		total += u.Amount
	}
	if total < amount {
		return nil, fmt.Errorf("INSUFFICIENT_FUNDS: owner holds %d, needs %d", total, amount)
	}
	return chosen, nil
}

func allUTXOs(ctx contractapi.TransactionContextInterface) ([]UTXO, error) {
	iter, err := ctx.GetStub().GetStateByPartialCompositeKey(utxoType, []string{})
	if err != nil {
		return nil, err
	}
	defer iter.Close()
	var out []UTXO
	for iter.HasNext() {
		kv, err := iter.Next()
		if err != nil {
			return nil, err
		}
		var u UTXO
		if err := json.Unmarshal(kv.Value, &u); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func merchantMCC(ctx contractapi.TransactionContextInterface, owner string) (string, error) {
	key, err := ctx.GetStub().CreateCompositeKey(merchantType, []string{owner})
	if err != nil {
		return "", err
	}
	data, err := ctx.GetStub().GetState(key)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func readSupply(ctx contractapi.TransactionContextInterface) (Supply, error) {
	var s Supply
	data, err := ctx.GetStub().GetState(supplyKey)
	if err != nil {
		return s, err
	}
	if len(data) == 0 {
		return s, nil
	}
	return s, json.Unmarshal(data, &s)
}

func writeSupply(ctx contractapi.TransactionContextInterface, s Supply) error {
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return ctx.GetStub().PutState(supplyKey, data)
}

func readReserve(ctx contractapi.TransactionContextInterface, owner string) (int64, error) {
	key, err := ctx.GetStub().CreateCompositeKey(reserveType, []string{owner})
	if err != nil {
		return 0, err
	}
	data, err := ctx.GetStub().GetState(key)
	if err != nil {
		return 0, err
	}
	if len(data) == 0 {
		return 0, nil
	}
	return strconv.ParseInt(string(data), 10, 64)
}

func writeReserve(ctx contractapi.TransactionContextInterface, owner string, amount int64) error {
	key, err := ctx.GetStub().CreateCompositeKey(reserveType, []string{owner})
	if err != nil {
		return err
	}
	return ctx.GetStub().PutState(key, []byte(strconv.FormatInt(amount, 10)))
}

func txTime(ctx contractapi.TransactionContextInterface) (time.Time, error) {
	ts, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return time.Time{}, err
	}
	return ts.AsTime(), nil
}

func validateRules(r *Rules) error {
	if r.Purpose == "" {
		return fmt.Errorf("INVALID_RULES: purpose is required")
	}
	if r.ReturnTo == "" {
		return fmt.Errorf("INVALID_RULES: returnTo is required")
	}
	if r.ExpiresAt != "" {
		if _, err := time.Parse(time.RFC3339, r.ExpiresAt); err != nil {
			return fmt.Errorf("INVALID_RULES: expiresAt must be RFC 3339")
		}
	}
	if r.MccAllowlist != nil && len(r.MccAllowlist) == 0 {
		return fmt.Errorf("INVALID_RULES: mccAllowlist cannot be empty")
	}
	if r.Geofence != nil && r.Geofence.RadiusM <= 0 {
		return fmt.Errorf("INVALID_RULES: geofence radius must be positive")
	}
	return nil
}

func isExpired(r *Rules, now time.Time) bool {
	if r == nil || r.ExpiresAt == "" {
		return false
	}
	exp, err := time.Parse(time.RFC3339, r.ExpiresAt)
	if err != nil {
		return false
	}
	return !now.Before(exp)
}

func evaluateRules(r *Rules, now time.Time, recipientMCC string, loc *Location) string {
	if isExpired(r, now) {
		return "EXPIRED"
	}
	if r.MccAllowlist != nil {
		if recipientMCC == "" {
			return "MERCHANT_REQUIRED"
		}
		allowed := false
		for _, m := range r.MccAllowlist {
			if m == recipientMCC {
				allowed = true
				break
			}
		}
		if !allowed {
			return "MCC_NOT_ALLOWED"
		}
	}
	if r.Geofence != nil {
		if loc == nil {
			return "LOCATION_REQUIRED"
		}
		if haversineMeters(loc.Lat, loc.Lng, r.Geofence.Lat, r.Geofence.Lng) > r.Geofence.RadiusM {
			return "OUTSIDE_GEOFENCE"
		}
	}
	return ""
}

func sameRules(a, b *Rules) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	return string(ja) == string(jb)
}

func haversineMeters(lat1, lng1, lat2, lng2 float64) float64 {
	const r = 6371000.0
	toRad := func(d float64) float64 { return d * math.Pi / 180 }
	dLat := toRad(lat2 - lat1)
	dLng := toRad(lng2 - lng1)
	h := math.Pow(math.Sin(dLat/2), 2) + math.Cos(toRad(lat1))*math.Cos(toRad(lat2))*math.Pow(math.Sin(dLng/2), 2)
	return 2 * r * math.Asin(math.Sqrt(h))
}
