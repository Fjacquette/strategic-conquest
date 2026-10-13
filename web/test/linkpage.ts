/**
 * Test page for link.ts (tools/web/test_link.py): exposes Link and CodeError to the test.
 */
import { CodeError, Link } from "../src/link.ts";

(window as unknown as Record<string, unknown>).SC_LINK = { Link, CodeError };
