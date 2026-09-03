package main

// Hand-written mocks for the slice of the Fabric interfaces this contract uses.
// Embedding the interfaces satisfies the full method set; anything the contract
// does not call would panic with a nil-pointer, which is the behaviour we want
// in a unit test.

import (
	"sort"
	"strings"
	"time"

	"github.com/hyperledger/fabric-chaincode-go/v2/pkg/cid"
	"github.com/hyperledger/fabric-chaincode-go/v2/shim"
	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
	"github.com/hyperledger/fabric-protos-go-apiv2/ledger/queryresult"
	"google.golang.org/protobuf/types/known/timestamppb"
)

const compositeSep = "\x00"

type mockStub struct {
	shim.ChaincodeStubInterface
	state map[string][]byte
	txID  string
	now   time.Time
}

func newMockStub() *mockStub {
	return &mockStub{state: map[string][]byte{}, txID: "tx1", now: time.Date(2026, 9, 3, 9, 0, 0, 0, time.UTC)}
}

func (m *mockStub) GetState(key string) ([]byte, error) { return m.state[key], nil }
func (m *mockStub) PutState(key string, value []byte) error {
	m.state[key] = append([]byte(nil), value...)
	return nil
}
func (m *mockStub) DelState(key string) error {
	delete(m.state, key)
	return nil
}
func (m *mockStub) GetTxID() string { return m.txID }
func (m *mockStub) GetTxTimestamp() (*timestamppb.Timestamp, error) {
	return timestamppb.New(m.now), nil
}
func (m *mockStub) CreateCompositeKey(objectType string, attributes []string) (string, error) {
	return compositeSep + objectType + compositeSep + strings.Join(attributes, compositeSep) + compositeSep, nil
}
func (m *mockStub) SplitCompositeKey(key string) (string, []string, error) {
	parts := strings.Split(strings.Trim(key, compositeSep), compositeSep)
	return parts[0], parts[1:], nil
}
func (m *mockStub) GetStateByPartialCompositeKey(objectType string, attributes []string) (shim.StateQueryIteratorInterface, error) {
	prefix := compositeSep + objectType + compositeSep
	if len(attributes) > 0 {
		prefix += strings.Join(attributes, compositeSep) + compositeSep
	}
	var keys []string
	for k := range m.state {
		if strings.HasPrefix(k, prefix) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	var kvs []*queryresult.KV
	for _, k := range keys {
		kvs = append(kvs, &queryresult.KV{Key: k, Value: m.state[k]})
	}
	return &mockIterator{items: kvs}, nil
}

type mockIterator struct {
	items []*queryresult.KV
	pos   int
}

func (it *mockIterator) HasNext() bool { return it.pos < len(it.items) }
func (it *mockIterator) Next() (*queryresult.KV, error) {
	kv := it.items[it.pos]
	it.pos++
	return kv, nil
}
func (it *mockIterator) Close() error { return nil }

type mockIdentity struct {
	cid.ClientIdentity
	id  string
	msp string
}

func (m *mockIdentity) GetID() (string, error)    { return m.id, nil }
func (m *mockIdentity) GetMSPID() (string, error) { return m.msp, nil }

type mockCtx struct {
	contractapi.TransactionContextInterface
	stub *mockStub
	id   *mockIdentity
}

func (c *mockCtx) GetStub() shim.ChaincodeStubInterface { return c.stub }
func (c *mockCtx) GetClientIdentity() cid.ClientIdentity  { return c.id }

// as returns a context for the same world state acting as a different caller in a new transaction.
func (c *mockCtx) as(id, msp, txID string) *mockCtx {
	c.stub.txID = txID
	return &mockCtx{stub: c.stub, id: &mockIdentity{id: id, msp: msp}}
}
