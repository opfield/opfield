package daemon

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	pb "github.com/opfield/opfield/daemon-shared/opfieldv1"
)

const registryIngressPort uint32 = 5444

func (p *NginxPlugin) SyncDockerRegistryBindings(command *pb.SyncDockerRegistryBindingsCommand) (string, error) {
	if p.registryLinks == nil {
		return "", errors.New("registry ingress manager is unavailable")
	}
	converted, err := registryIngressCommand(command)
	if err != nil {
		return "", err
	}
	statuses, err := p.registryLinks.sync(converted)
	if err != nil {
		return "", err
	}
	// Registry bindings are not persisted: the first sync after a restart is
	// what adopts the sockets the previous process kept, and the rest go.
	p.releaseUnclaimedRegistryListeners()
	detail, err := json.Marshal(map[string]any{"bindings": statuses})
	return string(detail), err
}

func registryIngressCommand(command *pb.SyncDockerRegistryBindingsCommand) (*pb.SyncProxySecureLinksCommand, error) {
	if command == nil {
		return nil, errors.New("registry ingress bindings are required")
	}
	converted := &pb.SyncProxySecureLinksCommand{Bindings: make([]*pb.ProxySecureLinkBinding, 0, len(command.Bindings))}
	seen := make(map[string]struct{}, len(command.Bindings))
	for _, binding := range command.Bindings {
		if binding.GetRole() != "ingress" || !secureLinkIDPattern.MatchString(binding.GetBindingId()) {
			return nil, errors.New("invalid registry ingress binding")
		}
		if binding.GetLocalAddress() != "127.0.0.1" || binding.GetLocalPort() != registryIngressPort {
			return nil, errors.New("registry ingress listener must use the reserved loopback address")
		}
		if binding.GetRelayOwnerKind() != registrySecureLinkOwnerKind || binding.GetRelayOwnerId() != binding.GetBindingId() {
			return nil, errors.New("invalid registry ingress relay ownership")
		}
		if binding.GetRepository() != "*" || !sameRegistryActions(binding.GetActions(), []string{"pull", "push"}) {
			return nil, errors.New("registry ingress must preserve registry-managed repository authorization")
		}
		if binding.GetAuthorization() != "" || binding.GetAuthorizationExpiresAtUnix() != 0 {
			return nil, errors.New("registry ingress must not inject registry authorization")
		}
		if _, duplicate := seen[binding.GetBindingId()]; duplicate {
			return nil, fmt.Errorf("duplicate registry ingress binding %s", binding.GetBindingId())
		}
		seen[binding.GetBindingId()] = struct{}{}
		converted.Bindings = append(converted.Bindings, &pb.ProxySecureLinkBinding{
			LinkId:       binding.GetBindingId(),
			Role:         "source",
			Generation:   binding.GetGeneration(),
			ListenerPort: binding.GetLocalPort(),
			SocketOnly:   true,
		})
	}
	return converted, nil
}

func sameRegistryActions(actual, expected []string) bool {
	left := append([]string(nil), actual...)
	right := append([]string(nil), expected...)
	sort.Strings(left)
	sort.Strings(right)
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
