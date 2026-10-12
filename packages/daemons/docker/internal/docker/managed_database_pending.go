package docker

import "sync"

// pendingCreates are the records of managed databases whose create command
// runs now: the record is saved only once the container is ready, but a
// ClickHouse set member's runtime must see the container while the command
// waits for it. A new copy's engine only answers once its Keeper joined the
// set, which needs the member runtime's mesh forwarders in the container
// (127.x.y.1:<raft port> of its peers), its joining marker and its peer
// endpoints serving; without the record the runtime saw no container and the
// copy's Keeper got "Connection refused" from every peer (rc.4 stand B).
type pendingCreates struct {
	mu      sync.Mutex
	records map[string]managedDatabaseRecord
}

func (p *pendingCreates) set(record managedDatabaseRecord) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.records == nil {
		p.records = map[string]managedDatabaseRecord{}
	}
	p.records[record.ID] = record
}

func (p *pendingCreates) clear(id string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.records, id)
}

func (p *pendingCreates) get(id string) (managedDatabaseRecord, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	record, ok := p.records[id]
	return record, ok
}
