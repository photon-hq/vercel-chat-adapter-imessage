import { describe, expect, it } from "vitest";
import { iMessageFormatConverter } from "./markdown";

const converter = new iMessageFormatConverter();

describe("iMessageFormatConverter", () => {
  describe("fromAst / toAst round-trip", () => {
    it("should handle plain text", () => {
      const ast = converter.toAst("Hello world");
      const result = converter.fromAst(ast);
      expect(result).toBe("Hello world");
    });

    it("should strip bold formatting", () => {
      const ast = converter.toAst("**bold text**");
      const result = converter.fromAst(ast);
      expect(result).toBe("bold text");
    });

    it("should strip italic formatting", () => {
      const ast = converter.toAst("_italic text_");
      const result = converter.fromAst(ast);
      expect(result).toBe("italic text");
    });

    it("should strip strikethrough formatting", () => {
      const ast = converter.toAst("~~deleted~~");
      const result = converter.fromAst(ast);
      expect(result).toBe("deleted");
    });

    it("should render links with URL", () => {
      const ast = converter.toAst("[click here](https://example.com)");
      const result = converter.fromAst(ast);
      expect(result).toBe("click here (https://example.com)");
    });

    it("should preserve inline code content", () => {
      const ast = converter.toAst("`code`");
      const result = converter.fromAst(ast);
      expect(result).toBe("code");
    });

    it("should preserve code block content", () => {
      const ast = converter.toAst("```\nconst x = 1;\n```");
      const result = converter.fromAst(ast);
      expect(result).toContain("const x = 1;");
    });

    it("should render unordered lists", () => {
      const ast = converter.toAst("- item 1\n- item 2");
      const result = converter.fromAst(ast);
      expect(result).toContain("- item 1");
      expect(result).toContain("- item 2");
    });

    it("should render ordered lists", () => {
      const ast = converter.toAst("1. first\n2. second");
      const result = converter.fromAst(ast);
      expect(result).toContain("1. first");
      expect(result).toContain("2. second");
    });

    it("should render blockquotes", () => {
      const ast = converter.toAst("> quoted text");
      const result = converter.fromAst(ast);
      expect(result).toContain("> quoted text");
    });
  });

  describe("renderPostable", () => {
    it("should pass through plain strings", () => {
      expect(converter.renderPostable("Hello")).toBe("Hello");
    });

    it("should pass through raw strings", () => {
      expect(converter.renderPostable({ raw: "raw text" })).toBe("raw text");
    });

    it("should convert markdown messages", () => {
      const result = converter.renderPostable({ markdown: "**bold**" });
      expect(result).toBe("bold");
    });
  });
});
