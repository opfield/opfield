package runtime

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/opfield/opfield/daemon-shared/legacycompat"
	"os"
	"path/filepath"
	"strings"
)

// dockerConfigBackupSuffix names the copy of the operator's daemon.json kept
// before Opfield changes it for the first time.
const dockerConfigBackupSuffix = ".opfield-backup"

// legacyDockerConfigBackupSuffix is that copy as a pre-Opfield daemon kept it:
// when it exists the operator's original is already kept there.
// legacy-name: the daemon.json backup of pre-Opfield nodes — remove once every node reports none
const legacyDockerConfigBackupSuffix = legacycompat.DockerConfigBackupSuffix

const runscHostNetworkArg = "--network=host"

type runscDockerRuntime struct {
	Path        string `json:"path"`
	RuntimeArgs []any  `json:"runtimeArgs"`
}

// writeRunscDockerConfig registers runsc in Docker's daemon.json. The file is
// left untouched when runsc is already registered with this path and the host
// network argument. Otherwise only the value of runtimes.runsc is inserted or
// replaced: every other byte of the operator's file stays as it is, and the
// original file is copied once to the daemon.json backup first. The
// returned function restores the file as it was before this call.
func writeRunscDockerConfig(path, runscPath string) (func() error, error) {
	original, readErr := os.ReadFile(path)
	existed := readErr == nil
	if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
		return nil, readErr
	}
	originalMode := os.FileMode(0o644)
	if existed {
		info, err := os.Stat(path)
		if err != nil {
			return nil, err
		}
		originalMode = info.Mode().Perm()
	}
	unchanged := func() error { return nil }
	if _, current, err := runscDockerConfigContentStatus(original, runscPath); err != nil {
		return nil, err
	} else if current {
		return unchanged, nil
	}
	runtimeArgs, err := existingRunscRuntimeArgs(original)
	if err != nil {
		return nil, err
	}
	hasHostNetwork := false
	for _, arg := range runtimeArgs {
		if arg == runscHostNetworkArg {
			hasHostNetwork = true
			break
		}
	}
	if !hasHostNetwork {
		runtimeArgs = append(runtimeArgs, runscHostNetworkArg)
	}
	content, err := setDockerConfigRunsc(original, runscDockerRuntime{Path: runscPath, RuntimeArgs: runtimeArgs})
	if err != nil {
		return nil, err
	}
	if _, current, err := runscDockerConfigContentStatus(content, runscPath); err != nil {
		return nil, err
	} else if !current {
		return nil, errors.New("the updated Docker daemon config does not register runsc")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	backupPath := path + dockerConfigBackupSuffix
	backedUp := false
	_, legacyErr := os.Lstat(path + legacyDockerConfigBackupSuffix)
	if existed && legacyErr != nil {
		backedUp, err = backupDockerConfig(backupPath, original, originalMode)
		if err != nil {
			return nil, fmt.Errorf("back up Docker daemon config: %w", err)
		}
	}
	if err := writeDockerConfigFile(path, content, originalMode); err != nil {
		if backedUp {
			_ = os.Remove(backupPath)
		}
		return nil, err
	}
	return func() error {
		var restoreErr error
		if existed {
			restoreErr = writeDockerConfigFile(path, original, originalMode)
		} else {
			restoreErr = os.Remove(path)
		}
		if restoreErr == nil && backedUp {
			restoreErr = os.Remove(backupPath)
		}
		return restoreErr
	}, nil
}

// backupDockerConfig keeps the first copy of the operator's file: an existing
// backup is never replaced.
func backupDockerConfig(path string, content []byte, mode os.FileMode) (bool, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if errors.Is(err, os.ErrExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if _, err := file.Write(content); err != nil {
		file.Close()
		_ = os.Remove(path)
		return false, err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		_ = os.Remove(path)
		return false, err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return false, err
	}
	return true, nil
}

func writeDockerConfigFile(path string, content []byte, mode os.FileMode) error {
	temp, err := os.CreateTemp(filepath.Dir(path), ".opfield-daemon-json-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if err := temp.Chmod(mode); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(content); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempName, path)
}

func runscDockerConfigStatus(path, runscPath string) (registered bool, current bool, err error) {
	content, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, false, nil
	}
	if err != nil {
		return false, false, err
	}
	return runscDockerConfigContentStatus(content, runscPath)
}

func runscDockerConfigContentStatus(content []byte, runscPath string) (registered bool, current bool, err error) {
	runsc, registered, err := decodeRunscDockerRuntime(content)
	if err != nil || !registered {
		return false, false, err
	}
	if runsc["path"] != runscPath {
		return true, false, nil
	}
	runtimeArgs, _ := runsc["runtimeArgs"].([]any)
	for _, arg := range runtimeArgs {
		if arg == runscHostNetworkArg {
			return true, true, nil
		}
	}
	return true, false, nil
}

func existingRunscRuntimeArgs(content []byte) ([]any, error) {
	runsc, _, err := decodeRunscDockerRuntime(content)
	if err != nil {
		return nil, err
	}
	runtimeArgs, _ := runsc["runtimeArgs"].([]any)
	return append([]any{}, runtimeArgs...), nil
}

func decodeRunscDockerRuntime(content []byte) (map[string]any, bool, error) {
	if len(bytes.TrimSpace(content)) == 0 {
		return nil, false, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.UseNumber()
	config := map[string]any{}
	if err := decoder.Decode(&config); err != nil {
		return nil, false, fmt.Errorf("parse Docker daemon config: %w", err)
	}
	runtimes, _ := config["runtimes"].(map[string]any)
	runsc, registered := runtimes["runsc"].(map[string]any)
	return runsc, registered, nil
}

// setDockerConfigRunsc returns content with runtimes.runsc set to runsc. An
// empty file gets a new config; otherwise the runsc value is replaced in place
// or inserted after the last member of runtimes, and runtimes is added after
// the last top-level member when it is missing, in the file's own indentation.
func setDockerConfigRunsc(content []byte, runsc runscDockerRuntime) ([]byte, error) {
	if len(bytes.TrimSpace(content)) == 0 {
		return renderNewDockerConfig(runsc)
	}
	if !json.Valid(content) {
		return nil, errors.New("parse Docker daemon config: invalid JSON")
	}
	start := bytes.IndexByte(content, '{')
	if start < 0 || strings.TrimSpace(string(content[:start])) != "" {
		return nil, errors.New("parse Docker daemon config: not a JSON object")
	}
	top, err := scanJSONObject(content, start)
	if err != nil {
		return nil, err
	}
	if len(top.members) == 0 {
		return renderNewDockerConfig(runsc)
	}
	unit := top.memberIndent(content)
	runtimesMember, hasRuntimes := top.member("runtimes")
	if !hasRuntimes {
		value, err := renderJSONValue(map[string]any{"runsc": runsc}, unit, unit, top.multiline(content))
		if err != nil {
			return nil, err
		}
		return top.appendMember(content, "runtimes", value), nil
	}
	runtimesIndent := lineIndent(content, runtimesMember.keyStart)
	if content[runtimesMember.valueStart] != '{' {
		value, err := renderJSONValue(map[string]any{"runsc": runsc}, runtimesIndent, unit, top.multiline(content))
		if err != nil {
			return nil, err
		}
		return splice(content, runtimesMember.valueStart, runtimesMember.valueEnd, value), nil
	}
	runtimes, err := scanJSONObject(content, runtimesMember.valueStart)
	if err != nil {
		return nil, err
	}
	if runscMember, ok := runtimes.member("runsc"); ok {
		value, err := renderJSONValue(runsc, lineIndent(content, runscMember.keyStart), unit, runtimes.multiline(content))
		if err != nil {
			return nil, err
		}
		return splice(content, runscMember.valueStart, runscMember.valueEnd, value), nil
	}
	if len(runtimes.members) == 0 {
		multiline := top.multiline(content)
		value, err := renderJSONValue(map[string]any{"runsc": runsc}, runtimesIndent, unit, multiline)
		if err != nil {
			return nil, err
		}
		return splice(content, runtimes.open, runtimes.close+1, value), nil
	}
	value, err := renderJSONValue(runsc, runtimes.memberIndent(content), unit, runtimes.multiline(content))
	if err != nil {
		return nil, err
	}
	return runtimes.appendMember(content, "runsc", value), nil
}

func renderNewDockerConfig(runsc runscDockerRuntime) ([]byte, error) {
	content, err := json.MarshalIndent(map[string]any{"runtimes": map[string]any{"runsc": runsc}}, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(content, '\n'), nil
}

func renderJSONValue(value any, indent, unit string, multiline bool) ([]byte, error) {
	if !multiline {
		return json.Marshal(value)
	}
	return json.MarshalIndent(value, indent, unit)
}

func splice(content []byte, start, end int, value []byte) []byte {
	result := make([]byte, 0, len(content)-(end-start)+len(value))
	result = append(result, content[:start]...)
	result = append(result, value...)
	return append(result, content[end:]...)
}

// lineIndent returns the whitespace before offset on its line, or "" when
// other text precedes it there.
func lineIndent(content []byte, offset int) string {
	lineStart := bytes.LastIndexByte(content[:offset], '\n') + 1
	indent := string(content[lineStart:offset])
	if strings.Trim(indent, " \t") != "" {
		return ""
	}
	return indent
}

// jsonObject holds the byte offsets of one object of an already validated JSON
// document, so a member can be changed without re-encoding the rest.
type jsonObject struct {
	open    int
	close   int
	members []jsonMember
}

type jsonMember struct {
	key        string
	keyStart   int
	valueStart int
	valueEnd   int
}

// member returns the last member named key, the one encoding/json and Docker
// use when a key repeats.
func (o jsonObject) member(key string) (jsonMember, bool) {
	for index := len(o.members) - 1; index >= 0; index-- {
		if o.members[index].key == key {
			return o.members[index], true
		}
	}
	return jsonMember{}, false
}

func (o jsonObject) leadingSpace(content []byte) []byte {
	if len(o.members) == 0 {
		return content[o.open+1 : o.close]
	}
	return content[o.open+1 : o.members[0].keyStart]
}

func (o jsonObject) multiline(content []byte) bool {
	return bytes.IndexByte(o.leadingSpace(content), '\n') >= 0
}

// memberIndent is the indentation of the object's member lines, or "" when
// the object is written on one line.
func (o jsonObject) memberIndent(content []byte) string {
	space := o.leadingSpace(content)
	newline := bytes.LastIndexByte(space, '\n')
	if newline < 0 {
		return ""
	}
	return string(space[newline+1:])
}

func (o jsonObject) appendMember(content []byte, key string, value []byte) []byte {
	separator := string(o.leadingSpace(content))
	if o.multiline(content) {
		separator = "\n" + o.memberIndent(content)
	}
	quotedKey, _ := json.Marshal(key)
	member := []byte("," + separator + string(quotedKey) + ": " + string(value))
	end := o.members[len(o.members)-1].valueEnd
	return splice(content, end, end, member)
}

func scanJSONObject(content []byte, open int) (jsonObject, error) {
	malformed := errors.New("parse Docker daemon config: malformed object")
	object := jsonObject{open: open}
	position := skipJSONSpace(content, open+1)
	if position < len(content) && content[position] == '}' {
		object.close = position
		return object, nil
	}
	for position < len(content) && content[position] == '"' {
		keyStart := position
		keyEnd, ok := jsonStringEnd(content, keyStart)
		if !ok {
			return object, malformed
		}
		var key string
		if err := json.Unmarshal(content[keyStart:keyEnd], &key); err != nil {
			return object, malformed
		}
		position = skipJSONSpace(content, keyEnd)
		if position >= len(content) || content[position] != ':' {
			return object, malformed
		}
		valueStart := skipJSONSpace(content, position+1)
		if valueStart >= len(content) {
			return object, malformed
		}
		decoder := json.NewDecoder(bytes.NewReader(content[valueStart:]))
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return object, malformed
		}
		valueEnd := valueStart + int(decoder.InputOffset())
		object.members = append(object.members, jsonMember{key: key, keyStart: keyStart, valueStart: valueStart, valueEnd: valueEnd})
		position = skipJSONSpace(content, valueEnd)
		if position >= len(content) {
			return object, malformed
		}
		switch content[position] {
		case ',':
			position = skipJSONSpace(content, position+1)
		case '}':
			object.close = position
			return object, nil
		default:
			return object, malformed
		}
	}
	return object, malformed
}

func skipJSONSpace(content []byte, position int) int {
	for position < len(content) {
		switch content[position] {
		case ' ', '\t', '\n', '\r':
			position++
		default:
			return position
		}
	}
	return position
}

// jsonStringEnd returns the offset just after the string whose opening quote
// is at start.
func jsonStringEnd(content []byte, start int) (int, bool) {
	for position := start + 1; position < len(content); position++ {
		switch content[position] {
		case '\\':
			position++
		case '"':
			return position + 1, true
		}
	}
	return 0, false
}
