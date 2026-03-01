/**
 * iMessage format conversion using AST-based parsing.
 *
 * iMessage supports plain text only -- no rich formatting syntax.
 * The converter strips formatting markers and outputs clean plain text,
 * preserving structure (lists, blockquotes, code blocks) with whitespace.
 */

import {
  BaseFormatConverter,
  type Content,
  getNodeChildren,
  getNodeValue,
  isBlockquoteNode,
  isCodeNode,
  isDeleteNode,
  isEmphasisNode,
  isInlineCodeNode,
  isLinkNode,
  isListItemNode,
  isListNode,
  isParagraphNode,
  isStrongNode,
  isTextNode,
  parseMarkdown,
  type Root,
} from "chat";

export class iMessageFormatConverter extends BaseFormatConverter {
  /**
   * Render an AST to iMessage plain text format.
   * Strips all formatting markers since iMessage doesn't support rich text via API.
   */
  fromAst(ast: Root): string {
    return this.fromAstWithNodeConverter(ast, (node) =>
      this.nodeToPlainText(node)
    );
  }

  /**
   * Parse iMessage text into an AST.
   * iMessage sends plain text, so we just parse it as markdown.
   */
  toAst(text: string): Root {
    return parseMarkdown(text);
  }

  private nodeToPlainText(node: Content): string {
    if (isParagraphNode(node)) {
      return getNodeChildren(node)
        .map((child) => this.nodeToPlainText(child))
        .join("");
    }

    if (isTextNode(node)) {
      return node.value;
    }

    if (isStrongNode(node) || isEmphasisNode(node) || isDeleteNode(node)) {
      return getNodeChildren(node)
        .map((child) => this.nodeToPlainText(child))
        .join("");
    }

    if (isInlineCodeNode(node)) {
      return node.value;
    }

    if (isCodeNode(node)) {
      return node.value;
    }

    if (isLinkNode(node)) {
      const linkText = getNodeChildren(node)
        .map((child) => this.nodeToPlainText(child))
        .join("");
      return linkText ? `${linkText} (${node.url})` : node.url;
    }

    if (isBlockquoteNode(node)) {
      return getNodeChildren(node)
        .map((child) => `> ${this.nodeToPlainText(child)}`)
        .join("\n");
    }

    if (isListNode(node)) {
      return getNodeChildren(node)
        .map((item, i) => {
          const prefix = node.ordered ? `${i + 1}.` : "-";
          const content = getNodeChildren(item)
            .map((child) => this.nodeToPlainText(child))
            .join("");
          return `${prefix} ${content}`;
        })
        .join("\n");
    }

    if (isListItemNode(node)) {
      return getNodeChildren(node)
        .map((child) => this.nodeToPlainText(child))
        .join("");
    }

    if (node.type === "break") {
      return "\n";
    }

    if (node.type === "thematicBreak") {
      return "---";
    }

    const children = getNodeChildren(node);
    if (children.length > 0) {
      return children.map((child) => this.nodeToPlainText(child)).join("");
    }
    return getNodeValue(node);
  }
}
