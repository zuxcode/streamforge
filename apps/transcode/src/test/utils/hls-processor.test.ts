import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listSegmentFiles } from "../../utils/temp-dir";

describe("listSegmentFiles", () => {
    const testDir = join(process.cwd(), "tmp-test-segments");

    console.log(testDir);

    beforeEach(async () => {
        await mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
        await rm(testDir, { recursive: true, force: true });
    });

    test("returns all .ts files recursively", async () => {
        await mkdir(join(testDir, "nested"), { recursive: true });

        await writeFile(join(testDir, "segment1.ts"), "");
        await writeFile(join(testDir, "nested", "segment2.ts"), "");
        await writeFile(join(testDir, "ignore.txt"), "");

        const result = await listSegmentFiles(testDir);

        expect(result).toEqual([
            "nested/segment2.ts",
            "segment1.ts",
        ]);
    });

    test("sorts files in numeric order", async () => {
        await writeFile(join(testDir, "10.ts"), "");
        await writeFile(join(testDir, "2.ts"), "");
        await writeFile(join(testDir, "1.ts"), "");

        const result = await listSegmentFiles(testDir);

        expect(result).toEqual([
            "1.ts",
            "2.ts",
            "10.ts",
        ]);
    });

    test("returns empty array when no .ts files exist", async () => {
        await writeFile(join(testDir, "file.txt"), "");

        const result = await listSegmentFiles(testDir);

        expect(result).toEqual([]);
    });

    test("returns empty array for empty directory", async () => {
        const result = await listSegmentFiles(testDir);

        expect(result).toEqual([]);
    });
});
