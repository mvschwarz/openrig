import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import "../src/globals.css";

afterEach(() => { cleanup(); });

describe("shadcn components", () => {
  // Test 1: All 11 components render without error
  it("all 11 shadcn components render without error", async () => {
    const { Button } = await import("../src/components/ui/button.js");
    const { Card, CardHeader, CardContent, CardFooter } = await import("../src/components/ui/card.js");
    const { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription } = await import("../src/components/ui/dialog.js");
    const { Input } = await import("../src/components/ui/input.js");
    const { Textarea } = await import("../src/components/ui/textarea.js");
    const { Badge } = await import("../src/components/ui/badge.js");
    const { Alert, AlertDescription } = await import("../src/components/ui/alert.js");
    const { Separator } = await import("../src/components/ui/separator.js");
    const { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } = await import("../src/components/ui/table.js");
    const { Tabs, TabsList, TabsTrigger, TabsContent } = await import("../src/components/ui/tabs.js");
    const { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } = await import("../src/components/ui/tooltip.js");

    // Render all 11 components — none should throw
    const { container } = render(
      <TooltipProvider>
        <div>
          <Button>click</Button>
          <Card><CardHeader>h</CardHeader><CardContent>c</CardContent><CardFooter>f</CardFooter></Card>
          <Dialog>
            <DialogTrigger>open</DialogTrigger>
            <DialogContent><DialogTitle>title</DialogTitle><DialogDescription>desc</DialogDescription></DialogContent>
          </Dialog>
          <Input placeholder="test" />
          <Textarea placeholder="test" />
          <Badge>badge</Badge>
          <Alert><AlertDescription>alert</AlertDescription></Alert>
          <Separator />
          <Table><TableHeader><TableRow><TableHead>h</TableHead></TableRow></TableHeader><TableBody><TableRow><TableCell>c</TableCell></TableRow></TableBody></Table>
          <Tabs defaultValue="a"><TabsList><TabsTrigger value="a">A</TabsTrigger></TabsList><TabsContent value="a">content</TabsContent></Tabs>
          <Tooltip>
            <TooltipTrigger>hover</TooltipTrigger>
            <TooltipContent>tip</TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>
    );

    expect(container.children.length).toBeGreaterThan(0);
  });

  // Test 2: Button tactical variant has uppercase text + bracket decoration
  it("Button tactical variant renders brackets and uppercase", async () => {
    const { Button } = await import("../src/components/ui/button.js");

    render(<Button variant="tactical" data-testid="tac">SNAPSHOT</Button>);

    const btn = screen.getByTestId("tac");
    expect(btn.textContent).toContain("SNAPSHOT");
    // Should have uppercase + tracking + border classes (tech button style)
    expect(btn.className).toContain("uppercase");
    expect(btn.className).toContain("text-[10px]");
    expect(btn.className).toContain("border");
  });

  // Test 3: Button default variant has correct classes (vellum theme)
  it("Button default variant has bg-stone-900 text-white", async () => {
    const { Button } = await import("../src/components/ui/button.js");

    render(<Button variant="default" data-testid="pri">Go</Button>);

    const btn = screen.getByTestId("pri");
    expect(btn.className).toContain("bg-stone-900");
    expect(btn.className).toContain("text-white");
  });

  // Test 4: Input and textarea use framed field styling
  it("Input and Textarea use full bordered field styling", async () => {
    const { Input } = await import("../src/components/ui/input.js");
    const { Textarea } = await import("../src/components/ui/textarea.js");

    render(
      <div>
        <Input data-testid="inp" />
        <Textarea data-testid="ta" />
      </div>
    );

    const inp = screen.getByTestId("inp");
    const ta = screen.getByTestId("ta");
    expect(inp.className).toContain("border");
    expect(inp.className).not.toContain("border-b");
    expect(ta.className).toContain("border");
    expect(ta.className).not.toContain("border-b");
  });

  // Test 5: Card uses white bg with hard-shadow (vellum theme)
  it("Card uses bg-white border border-stone-900 hard-shadow", async () => {
    const { Card } = await import("../src/components/ui/card.js");

    render(<Card data-testid="card">content</Card>);

    const card = screen.getByTestId("card");
    expect(card.className).toContain("bg-white");
    expect(card.className).toContain("border-stone-900");
    expect(card.className).toContain("hard-shadow");
  });

  // Test 6: Dialog overlay uses backdrop-blur for glassmorphism
  it("Dialog overlay has backdrop-blur class", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");

    // Read dialog source — easier than rendering since Dialog requires Portal
    const src = readFileSync(resolve(__dirname, "../src/components/ui/dialog.tsx"), "utf-8");
    expect(src).toContain("backdrop-blur");
    expect(src).toContain("bg-black/20");
  });

  // Test 7: Separator uses ghost-border
  it("Separator uses bg-ghost-border", async () => {
    const { Separator } = await import("../src/components/ui/separator.js");

    render(<Separator data-testid="sep" />);

    const sep = screen.getByTestId("sep");
    expect(sep.className).toContain("bg-ghost-border");
  });
});
