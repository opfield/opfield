-- The bastion node type is gone. Records of that type (the API accepted them before 2.12.3 although no daemon could
-- enroll one) are deleted with whatever points at them, then node_type is recreated without the value.
DO $$
DECLARE
	fk record;
BEGIN
	IF EXISTS (SELECT 1 FROM "nodes" WHERE "type" = 'bastion') THEN
		FOR fk IN
			SELECT c."conrelid"::regclass AS "tbl", a."attname" AS "col"
			FROM pg_constraint AS c
			JOIN pg_attribute AS a ON a."attrelid" = c."conrelid" AND a."attnum" = c."conkey"[1]
			WHERE c."contype" = 'f'
				AND c."confrelid" = '"public"."nodes"'::regclass
				AND c."confdeltype" IN ('a', 'r')
				AND cardinality(c."conkey") = 1
		LOOP
			EXECUTE format(
				'DELETE FROM %s WHERE %I IN (SELECT "id" FROM "public"."nodes" WHERE "type" = ''bastion'')',
				fk."tbl",
				fk."col"
			);
		END LOOP;
		DELETE FROM "nodes" WHERE "type" = 'bastion';
	END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "nodes" ALTER COLUMN "type" DROP DEFAULT;--> statement-breakpoint
ALTER TYPE "public"."node_type" RENAME TO "node_type_0275_old";--> statement-breakpoint
CREATE TYPE "public"."node_type" AS ENUM('nginx', 'monitoring', 'docker', 'builder', 'databases', 'storage', 'relay');--> statement-breakpoint
ALTER TABLE "nodes" ALTER COLUMN "type" SET DATA TYPE "public"."node_type" USING "type"::text::"public"."node_type";--> statement-breakpoint
ALTER TABLE "nodes" ALTER COLUMN "type" SET DEFAULT 'nginx';--> statement-breakpoint
DROP TYPE "public"."node_type_0275_old";
