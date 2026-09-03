package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

const (
	rbiID    = "x509::CN=rbi::O=RBI"
	bankAID  = "x509::CN=bank-a::O=BankA"
	bankBID  = "x509::CN=bank-b::O=BankB"
	ashaID   = "x509::CN=asha::O=BankA"
	dealerID = "x509::CN=kisan-agro::O=BankA"
	shopID   = "x509::CN=nandini::O=BankB"
	schemeID = "x509::CN=fert-subsidy::O=BankA"
)

func ids(u []UTXO) string {
	var out []string
	for _, t := range u {
		out = append(out, t.ID)
	}
	b, _ := json.Marshal(out)
	return string(b)
}

func outputs(o ...Output) string {
	b, _ := json.Marshal(o)
	return string(b)
}

func sum(u []UTXO) int64 {
	var t int64
	for _, x := range u {
		t += x.Amount
	}
	return t
}

func mustOK(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func mustFail(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected %s, got success", code)
	}
	if !strings.Contains(err.Error(), code) {
		t.Fatalf("expected %s, got %v", code, err)
	}
}

func assertSupply(t *testing.T, sc *SmartContract, ctx *mockCtx) {
	t.Helper()
	rep, err := sc.Supply(ctx)
	mustOK(t, err)
	if !rep.Ok {
		t.Fatalf("conservation broken: %+v", rep)
	}
}

// world: RBI mints, sets bank-a's reserve, issues to bank-a, bank-a pays Asha.
func world(t *testing.T) (*SmartContract, *mockCtx) {
	sc := &SmartContract{}
	ctx := &mockCtx{stub: newMockStub(), id: &mockIdentity{id: rbiID, msp: CentralBankMSP}}
	minted, err := sc.Mint(ctx, 100_000_00)
	mustOK(t, err)
	if sum(minted) != 100_000_00 {
		t.Fatalf("minted %d", sum(minted))
	}
	mustOK(t, sc.SetReserve(ctx.as(rbiID, CentralBankMSP, "tx2"), bankAID, 50_000_00))
	issued, err := sc.Issue(ctx.as(rbiID, CentralBankMSP, "tx3"), bankAID, 20_000_00)
	mustOK(t, err)
	if sum(issued) != 20_000_00 {
		t.Fatalf("issued %d", sum(issued))
	}
	bankTokens, _ := sc.UTXOsOf(ctx, bankAID)
	_, err = sc.Transfer(ctx.as(bankAID, "BankAMSP", "tx4"), ids(bankTokens), outputs(
		Output{Owner: ashaID, Amount: 2_000_00},
		Output{Owner: bankAID, Amount: 18_000_00},
	), "")
	mustOK(t, err)
	assertSupply(t, sc, ctx)
	return sc, ctx
}

func TestMintIsCentralBankOnly(t *testing.T) {
	sc := &SmartContract{}
	ctx := &mockCtx{stub: newMockStub(), id: &mockIdentity{id: bankAID, msp: "BankAMSP"}}
	_, err := sc.Mint(ctx, 1000)
	mustFail(t, err, "FORBIDDEN")
	_, err = sc.Mint(ctx.as(rbiID, CentralBankMSP, "tx1"), 75)
	mustFail(t, err, "INVALID_AMOUNT")
	minted, err := sc.Mint(ctx.as(rbiID, CentralBankMSP, "tx1"), 1_234_50)
	mustOK(t, err)
	if sum(minted) != 1_234_50 {
		t.Fatalf("sum %d", sum(minted))
	}
	for _, u := range minted {
		if u.Owner != rbiID || u.CreatedBy != "tx1" {
			t.Fatalf("bad token %+v", u)
		}
		valid := false
		for _, d := range Denominations {
			if u.Amount == d {
				valid = true
			}
		}
		if !valid {
			t.Fatalf("token %s has non-standard amount %d", u.ID, u.Amount)
		}
	}
	assertSupply(t, sc, ctx)
}

func TestIssueDebitsReserveAndRefusesBeyondIt(t *testing.T) {
	sc, ctx := world(t)
	reserve, _ := sc.Reserve(ctx, bankAID)
	if reserve != 30_000_00 {
		t.Fatalf("reserve %d", reserve)
	}
	_, err := sc.Issue(ctx.as(rbiID, CentralBankMSP, "tx5"), bankAID, 40_000_00)
	mustFail(t, err, "INSUFFICIENT_RESERVE")
	_, err = sc.Issue(ctx.as(bankAID, "BankAMSP", "tx6"), bankAID, 100)
	mustFail(t, err, "FORBIDDEN")
}

func TestTransferRejectsUnbalancedForeignAndDoubleSpends(t *testing.T) {
	sc, ctx := world(t)
	asha, _ := sc.UTXOsOf(ctx, ashaID)
	if sum(asha) != 2_000_00 {
		t.Fatalf("asha holds %d", sum(asha))
	}
	_, err := sc.Transfer(ctx.as(ashaID, "BankAMSP", "tx5"), ids(asha), outputs(Output{Owner: shopID, Amount: 2_000_50}), "")
	mustFail(t, err, "UNBALANCED")
	_, err = sc.Transfer(ctx.as(shopID, "BankBMSP", "tx6"), ids(asha), outputs(Output{Owner: shopID, Amount: 2_000_00}), "")
	mustFail(t, err, "NOT_OWNER")

	_, err = sc.Transfer(ctx.as(ashaID, "BankAMSP", "tx7"), ids(asha), outputs(Output{Owner: shopID, Amount: 1_500_00}, Output{Owner: ashaID, Amount: 500_00}), "")
	mustOK(t, err)
	_, err = sc.Transfer(ctx.as(ashaID, "BankAMSP", "tx8"), ids(asha), outputs(Output{Owner: shopID, Amount: 2_000_00}), "")
	mustFail(t, err, "UNKNOWN_TOKEN")
	shop, _ := sc.UTXOsOf(ctx, shopID)
	if sum(shop) != 1_500_00 {
		t.Fatalf("shop holds %d", sum(shop))
	}
	assertSupply(t, sc, ctx)
}

func TestPurposeBoundTokens(t *testing.T) {
	sc, ctx := world(t)
	mustOK(t, sc.RegisterMerchant(ctx.as(bankAID, "BankAMSP", "tx5"), dealerID, "0763"))
	mustOK(t, sc.RegisterMerchant(ctx.as(bankBID, "BankBMSP", "tx6"), shopID, "5411"))

	// Fund the scheme wallet from bank-a, then disburse with rules.
	bank, _ := sc.UTXOsOf(ctx, bankAID)
	_, err := sc.Transfer(ctx.as(bankAID, "BankAMSP", "tx7"), ids(bank), outputs(Output{Owner: schemeID, Amount: 5_000_00}, Output{Owner: bankAID, Amount: sum(bank) - 5_000_00}), "")
	mustOK(t, err)
	rules := &Rules{
		Purpose:      "FERT-SUBSIDY-2026",
		ReturnTo:     schemeID,
		MccAllowlist: []string{"0763"},
		ExpiresAt:    ctx.stub.now.Add(90 * 24 * time.Hour).Format(time.RFC3339),
		Geofence:     &GeoFence{Lat: 15.85, Lng: 74.5, RadiusM: 50_000},
	}
	scheme, _ := sc.UTXOsOf(ctx, schemeID)
	_, err = sc.Transfer(ctx.as(schemeID, "BankAMSP", "tx8"), ids(scheme), outputs(Output{Owner: ashaID, Amount: 2_000_00, Rules: rules}, Output{Owner: schemeID, Amount: 3_000_00}), "")
	mustOK(t, err)

	bound := func() []UTXO {
		all, _ := sc.UTXOsOf(ctx, ashaID)
		var out []UTXO
		for _, u := range all {
			if u.Rules != nil {
				out = append(out, u)
			}
		}
		return out
	}
	if sum(bound()) != 2_000_00 {
		t.Fatalf("bound %d", sum(bound()))
	}

	inZone := `{"location":{"lat":15.87,"lng":74.52}}`
	farAway := `{"location":{"lat":12.97,"lng":77.59}}`
	_, err = sc.Transfer(ctx.as(ashaID, "BankAMSP", "tx9"), ids(bound()), outputs(Output{Owner: shopID, Amount: 300_00}, Output{Owner: ashaID, Amount: 1_700_00}), inZone)
	mustFail(t, err, "MCC_NOT_ALLOWED")
	_, err = sc.Transfer(ctx.as(ashaID, "BankAMSP", "tx10"), ids(bound()), outputs(Output{Owner: dealerID, Amount: 300_00}, Output{Owner: ashaID, Amount: 1_700_00}), farAway)
	mustFail(t, err, "OUTSIDE_GEOFENCE")
	_, err = sc.Transfer(ctx.as(ashaID, "BankAMSP", "tx11"), ids(bound()), outputs(Output{Owner: dealerID, Amount: 300_00, Rules: rules}, Output{Owner: ashaID, Amount: 1_700_00}), inZone)
	mustFail(t, err, "RULES_NOT_ALLOWED")

	created, err := sc.Transfer(ctx.as(ashaID, "BankAMSP", "tx12"), ids(bound()), outputs(Output{Owner: dealerID, Amount: 1_500_00}, Output{Owner: ashaID, Amount: 500_00}), inZone)
	mustOK(t, err)
	for _, u := range created {
		if u.Owner == dealerID && u.Rules != nil {
			t.Fatalf("dealer received bound tokens")
		}
		if u.Owner == ashaID && (u.Rules == nil || u.Rules.Purpose != "FERT-SUBSIDY-2026") {
			t.Fatalf("change lost its rules: %+v", u)
		}
	}
	if sum(bound()) != 500_00 {
		t.Fatalf("change %d", sum(bound()))
	}

	// Mixing bound and unrestricted inputs is refused.
	all, _ := sc.UTXOsOf(ctx, ashaID)
	_, err = sc.Transfer(ctx.as(ashaID, "BankAMSP", "tx13"), ids(all), outputs(Output{Owner: dealerID, Amount: sum(all)}), inZone)
	mustFail(t, err, "MIXED_RULES")

	// 91 days later: expired at spend time, then swept back to the scheme.
	ctx.stub.now = ctx.stub.now.Add(91 * 24 * time.Hour)
	_, err = sc.Transfer(ctx.as(ashaID, "BankAMSP", "tx14"), ids(bound()), outputs(Output{Owner: dealerID, Amount: 500_00}), inZone)
	mustFail(t, err, "EXPIRED")
	swept, err := sc.SweepExpired(ctx.as(rbiID, CentralBankMSP, "tx15"))
	mustOK(t, err)
	if sum(swept) != 500_00 {
		t.Fatalf("swept %d", sum(swept))
	}
	schemeAfter, _ := sc.UTXOsOf(ctx, schemeID)
	if sum(schemeAfter) != 3_500_00 {
		t.Fatalf("scheme holds %d", sum(schemeAfter))
	}
	if len(bound()) != 0 {
		t.Fatalf("bound tokens remain")
	}
	assertSupply(t, sc, ctx)
}

func TestRedeemAndBurnKeepConservation(t *testing.T) {
	sc, ctx := world(t)
	bank, _ := sc.UTXOsOf(ctx, bankAID)
	var pick []UTXO
	var total int64
	for _, u := range bank {
		if total >= 5_000_00 {
			break
		}
		pick = append(pick, u)
		total += u.Amount
	}
	redeemed, err := sc.Redeem(ctx.as(bankAID, "BankAMSP", "tx5"), ids(pick))
	mustOK(t, err)
	if redeemed != total {
		t.Fatalf("redeemed %d", redeemed)
	}
	reserve, _ := sc.Reserve(ctx, bankAID)
	if reserve != 30_000_00+total {
		t.Fatalf("reserve %d", reserve)
	}

	rbi, _ := sc.UTXOsOf(ctx, rbiID)
	burned, err := sc.Burn(ctx.as(rbiID, CentralBankMSP, "tx6"), ids(rbi[:2]))
	mustOK(t, err)
	if burned != rbi[0].Amount+rbi[1].Amount {
		t.Fatalf("burned %d", burned)
	}
	_, err = sc.Burn(ctx.as(bankAID, "BankAMSP", "tx7"), ids(rbi[2:3]))
	mustFail(t, err, "FORBIDDEN")
	rep, _ := sc.Supply(ctx)
	if rep.Burned != burned || !rep.Ok {
		t.Fatalf("supply %+v", rep)
	}
}

func TestTokenIdsDeriveFromTransaction(t *testing.T) {
	sc, ctx := world(t)
	asha, _ := sc.UTXOsOf(ctx, ashaID)
	created, err := sc.Transfer(ctx.as(ashaID, "BankAMSP", "tx-det"), ids(asha), outputs(Output{Owner: shopID, Amount: 2_000_00}), "")
	mustOK(t, err)
	for i, u := range created {
		if !strings.HasPrefix(u.ID, "tx-det.") || u.CreatedBy != "tx-det" {
			t.Fatalf("token %d id %s", i, u.ID)
		}
	}
}
