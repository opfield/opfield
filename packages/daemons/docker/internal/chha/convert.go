package chha

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Converting a single-node database (P0-T02 item 5). The table flag
// convert_to_replicated turns MergeTree-family tables into Replicated ones at
// the one restart that adds Keeper (the docker side places the flags); there
// is no database flag, so the holder then moves each table into a new
// Replicated database without copying (hard links) and swaps the names:
//
//  1. CREATE DATABASE <db>_gwnew ENGINE = Replicated('/gw/db/<db>', ...)
//  2. each converted table recreated there (no Keeper path arguments, the
//     Replicated database gives them), plain views too;
//  3. ATTACH PARTITION ALL FROM (>= 25.3) or per partition id (24.x);
//  4. RENAME DATABASE <db> TO <db>_gwold, <db>_gwnew TO <db>.
//
// Client writes are held (client profile read-only) during 1-4. Objects that
// cannot live in a Replicated database (Log/TinyLog/Memory tables,
// materialized views, dictionaries) stay in <db>_gwold; Opfield lists them in
// the convert confirmation.
const (
	convertSuffixOld = "_gwold"
	convertSuffixNew = "_gwnew"
)

var (
	createTablePrefix = regexp.MustCompile("^CREATE (TABLE|VIEW) (`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)\\.(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*) ")
	tableUUIDClause   = regexp.MustCompile(` UUID '[0-9a-f-]{36}'`)
	replicatedArgs    = regexp.MustCompile(`ENGINE = (Replicated[A-Za-z]*MergeTree)\('(?:[^'\\]|\\.)*',\s*'(?:[^'\\]|\\.)*'(,\s*)?`)
)

func quoteIdent(name string) string {
	return "`" + strings.ReplaceAll(name, "`", "``") + "`"
}

func quoteLiteral(value string) string {
	return "'" + strings.NewReplacer(`\`, `\\`, `'`, `\'`).Replace(value) + "'"
}

// createDatabaseSQL joins or creates the set's Replicated database name.
func createDatabaseSQL(local, name string) string {
	return fmt.Sprintf("CREATE DATABASE IF NOT EXISTS %s ENGINE = Replicated(%s, %s, '{replica}')",
		quoteIdent(local), quoteLiteral(DatabasePathPrefix+"/"+name), quoteLiteral(Shard))
}

// movableCreate rewrites an old table's CREATE query for the new Replicated
// database: the target database, IF NOT EXISTS, no UUID and no explicit
// Keeper path/replica arguments. ok is false for objects that stay behind
// (not a Replicated*MergeTree table, not a plain view).
func movableCreate(query, engine, newDatabase string) (string, bool) {
	query = strings.TrimSpace(query)
	match := createTablePrefix.FindStringSubmatch(query)
	if match == nil {
		return "", false
	}
	kind := match[1]
	switch {
	case kind == "VIEW" && engine == "View":
	case kind == "TABLE" && strings.HasPrefix(engine, "Replicated") && strings.HasSuffix(engine, "MergeTree"):
	default:
		return "", false
	}
	rest := query[len(match[0]):]
	rewritten := fmt.Sprintf("CREATE %s IF NOT EXISTS %s.%s %s", kind, quoteIdent(newDatabase), match[3], rest)
	rewritten = tableUUIDClause.ReplaceAllString(rewritten, "")
	if kind == "TABLE" {
		rewritten = replicatedArgs.ReplaceAllString(rewritten, "ENGINE = $1(")
		rewritten = strings.Replace(rewritten, "MergeTree()", "MergeTree", 1)
	}
	return rewritten, true
}

// attachAllSupported: ATTACH PARTITION ALL FROM exists from 25.3 on.
func attachAllSupported(version string) bool {
	parts := strings.SplitN(version, ".", 3)
	if len(parts) < 2 {
		return false
	}
	major, err1 := strconv.Atoi(parts[0])
	minor, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil {
		return false
	}
	return major > 25 || (major == 25 && minor >= 3)
}

// convertObject is one object of a database being converted.
type convertObject struct {
	name, engine, create string
}

// convertDatabase moves name (Atomic) into a Replicated database of the same
// name. Every step is idempotent, so a crash or a lost lease in the middle is
// resumed by the next run. It returns the objects left in <name>_gwold.
func (e *engine) convertDatabase(ctx context.Context, name string) ([]string, error) {
	oldName, newName := name+convertSuffixOld, name+convertSuffixNew
	engines, err := e.databaseEngines(ctx)
	if err != nil {
		return nil, err
	}
	switch {
	case engines[name] == "Replicated":
		return nil, nil
	case engines[name] == "" && engines[oldName] != "" && engines[newName] == "Replicated":
		_, err := e.rt.Query(ctx, fmt.Sprintf("RENAME DATABASE %s TO %s", quoteIdent(newName), quoteIdent(name)))
		return nil, err
	case engines[name] == "":
		return nil, fmt.Errorf("database %s does not exist", name)
	}
	version, err := e.rt.Query(ctx, "SELECT version() FORMAT TabSeparatedRaw")
	if err != nil {
		return nil, err
	}
	if _, err := e.rt.Query(ctx, createDatabaseSQL(newName, name)); err != nil {
		return nil, fmt.Errorf("create the Replicated database: %w", err)
	}
	listing, err := e.rt.Query(ctx, fmt.Sprintf(
		"SELECT name, engine, replaceRegexpAll(create_table_query, '[\\n\\t]', ' ') FROM system.tables WHERE database = %s AND NOT is_temporary ORDER BY engine = 'View', name FORMAT TabSeparatedRaw",
		quoteLiteral(name)))
	if err != nil {
		return nil, err
	}
	var objects []convertObject
	for _, line := range strings.Split(strings.TrimSpace(listing), "\n") {
		fields := strings.SplitN(line, "\t", 3)
		if len(fields) == 3 {
			objects = append(objects, convertObject{name: fields[0], engine: fields[1], create: fields[2]})
		}
	}
	var leftBehind []string
	for _, object := range objects {
		create, ok := movableCreate(object.create, object.engine, newName)
		if !ok {
			leftBehind = append(leftBehind, object.name)
			continue
		}
		if _, err := e.rt.Query(ctx, create); err != nil {
			return nil, fmt.Errorf("recreate %s: %w", object.name, err)
		}
		if object.engine == "View" {
			continue
		}
		if err := e.moveParts(ctx, name, newName, object.name, attachAllSupported(strings.TrimSpace(version))); err != nil {
			return nil, fmt.Errorf("move the data of %s: %w", object.name, err)
		}
	}
	if _, err := e.rt.Query(ctx, fmt.Sprintf("RENAME DATABASE %s TO %s", quoteIdent(name), quoteIdent(oldName))); err != nil {
		return nil, err
	}
	if _, err := e.rt.Query(ctx, fmt.Sprintf("RENAME DATABASE %s TO %s", quoteIdent(newName), quoteIdent(name))); err != nil {
		return nil, err
	}
	return leftBehind, nil
}

// moveParts attaches the old table's parts to the new one by hard links,
// skipping what the new table already has (a resumed run).
func (e *engine) moveParts(ctx context.Context, oldDatabase, newDatabase, table string, attachAll bool) error {
	present, err := e.rt.Query(ctx, fmt.Sprintf(
		"SELECT DISTINCT partition_id FROM system.parts WHERE database = %s AND table = %s AND active FORMAT TabSeparatedRaw",
		quoteLiteral(newDatabase), quoteLiteral(table)))
	if err != nil {
		return err
	}
	have := map[string]bool{}
	for _, id := range strings.Fields(present) {
		have[id] = true
	}
	source := quoteIdent(oldDatabase) + "." + quoteIdent(table)
	target := quoteIdent(newDatabase) + "." + quoteIdent(table)
	if attachAll && len(have) == 0 {
		_, err := e.rt.Query(ctx, fmt.Sprintf("ALTER TABLE %s ATTACH PARTITION ALL FROM %s", target, source))
		return err
	}
	ids, err := e.rt.Query(ctx, fmt.Sprintf(
		"SELECT DISTINCT partition_id FROM system.parts WHERE database = %s AND table = %s AND active FORMAT TabSeparatedRaw",
		quoteLiteral(oldDatabase), quoteLiteral(table)))
	if err != nil {
		return err
	}
	for _, id := range strings.Fields(ids) {
		if have[id] {
			continue
		}
		if _, err := e.rt.Query(ctx, fmt.Sprintf("ALTER TABLE %s ATTACH PARTITION ID %s FROM %s", target, quoteLiteral(id), source)); err != nil {
			return err
		}
	}
	return nil
}

// databaseEngines maps every database to its engine.
func (e *engine) databaseEngines(ctx context.Context) (map[string]string, error) {
	text, err := e.rt.Query(ctx, "SELECT name, engine FROM system.databases FORMAT TabSeparatedRaw")
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(text), "\n") {
		name, engine, ok := strings.Cut(line, "\t")
		if ok {
			out[name] = engine
		}
	}
	return out, nil
}
