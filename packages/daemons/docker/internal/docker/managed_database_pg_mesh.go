package docker

import "context"

// pgSetMesh is how a Postgres member reaches its set's member mesh aliases on
// the set's private network: the subset of the generic member mesh
// (set_member_mesh.go) the Postgres runtime uses.
type pgSetMesh interface {
	// Ensure creates the set's private network (idempotent) and returns its name.
	Ensure(ctx context.Context, setID string) (string, error)
	// Expose serves host:port on the network's gateway, carrying connections
	// to the alias through the member's relay peer routes.
	Expose(setID, host string, port uint16, alias string)
	// ExtraHosts are "<host>:<gateway ip>" for every exposed host.
	ExtraHosts(setID string) []string
	// Release closes the set's listeners and connections.
	Release(setID string)
}

// pgMesh is the member mesh Postgres members use: the plugin's generic mesh.
func (p *DockerPlugin) pgMesh() pgSetMesh {
	return pgMeshAdapter{mesh: p.setMesh()}
}

type pgMeshAdapter struct {
	mesh *setMesh
}

func (a pgMeshAdapter) Ensure(ctx context.Context, setID string) (string, error) {
	return a.mesh.Ensure(ctx, setID)
}

func (a pgMeshAdapter) Expose(setID, host string, port uint16, alias string) {
	a.mesh.Expose(setID, host, port, alias)
}

func (a pgMeshAdapter) ExtraHosts(setID string) []string {
	return a.mesh.ExtraHosts(setID)
}

func (a pgMeshAdapter) Release(setID string) {
	a.mesh.Release(context.Background(), setID)
}
