// V1 Shell Redesign — Phase 1 — VellumCard primitive.
//
// API surface tests: default render, header, registrationMarks toggle,
// elevation + variant variants, accentClass, href (Link wrapper),
// polymorphic as prop, testId.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { VellumCard } from "../src/components/ui/vellum-card";

describe("VellumCard (Phase 1 primitive)", () => {
  it("renders children", () => {
    render(<VellumCard>HELLO</VellumCard>);
    expect(screen.getByText("HELLO")).toBeTruthy();
  });

  it("default container carries vellum classes (bg-white + border-stone-900 + hard-shadow)", () => {
    const { container } = render(<VellumCard testId="vc">x</VellumCard>);
    const el = container.querySelector("[data-testid='vc']") as HTMLElement;
    expect(el.className).toContain("bg-white");
    expect(el.className).toContain("border-stone-900");
    expect(el.className).toContain("hard-shadow");
  });

  it("renders 4 registration mark corners by default", () => {
    const { container } = render(<VellumCard>x</VellumCard>);
    expect(container.querySelector(".reg-tl")).toBeTruthy();
    expect(container.querySelector(".reg-tr")).toBeTruthy();
    expect(container.querySelector(".reg-bl")).toBeTruthy();
    expect(container.querySelector(".reg-br")).toBeTruthy();
  });

  it("registrationMarks={false} omits all 4 corners", () => {
    const { container } = render(
      <VellumCard registrationMarks={false}>x</VellumCard>,
    );
    expect(container.querySelector(".reg-tl")).toBeNull();
    expect(container.querySelector(".reg-tr")).toBeNull();
    expect(container.querySelector(".reg-bl")).toBeNull();
    expect(container.querySelector(".reg-br")).toBeNull();
  });

  it("renders dark header stripe when header prop given", () => {
    render(<VellumCard header="RIG: VELOCITY">x</VellumCard>);
    expect(screen.getByText("RIG: VELOCITY")).toBeTruthy();
  });

  it("variant=ghost replaces primary surface classes", () => {
    const { container } = render(
      <VellumCard variant="ghost" testId="vc-g">x</VellumCard>,
    );
    const el = container.querySelector("[data-testid='vc-g']") as HTMLElement;
    expect(el.className).toContain("bg-transparent");
    expect(el.className).not.toContain("bg-white");
  });

  it("elevation=flat omits hard-shadow", () => {
    const { container } = render(
      <VellumCard elevation="flat" testId="vc-f">x</VellumCard>,
    );
    const el = container.querySelector("[data-testid='vc-f']") as HTMLElement;
    expect(el.className).not.toContain("hard-shadow");
  });

  it("accentClass merges into the container", () => {
    const { container } = render(
      <VellumCard accentClass="border-l-4 border-l-tertiary" testId="vc-a">x</VellumCard>,
    );
    const el = container.querySelector("[data-testid='vc-a']") as HTMLElement;
    expect(el.className).toContain("border-l-tertiary");
  });

  it("href wraps in an <a>", () => {
    const { container } = render(
      <VellumCard href="/foo" testId="vc-l">x</VellumCard>,
    );
    const a = container.querySelector("a[data-testid='vc-l']");
    expect(a).toBeTruthy();
    expect(a?.getAttribute("href")).toBe("/foo");
  });

  it("as=article renders an <article>", () => {
    const { container } = render(
      <VellumCard as="article" testId="vc-art">x</VellumCard>,
    );
    expect(container.querySelector("article[data-testid='vc-art']")).toBeTruthy();
  });

  it("as=section renders a <section>", () => {
    const { container } = render(
      <VellumCard as="section" testId="vc-sec">x</VellumCard>,
    );
    expect(container.querySelector("section[data-testid='vc-sec']")).toBeTruthy();
  });

  it("interactive (href) carries focus-visible classes", () => {
    const { container } = render(
      <VellumCard href="/foo" testId="vc-fv-href">x</VellumCard>,
    );
    const el = container.querySelector("[data-testid='vc-fv-href']") as HTMLElement;
    expect(el.className).toContain("focus-visible:outline");
    expect(el.className).toContain("focus-visible:outline-stone-900");
  });

  it("interactive (onClick) carries focus-visible classes", () => {
    const { container } = render(
      <VellumCard onClick={() => {}} testId="vc-fv-click">x</VellumCard>,
    );
    const el = container.querySelector("[data-testid='vc-fv-click']") as HTMLElement;
    expect(el.className).toContain("focus-visible:outline");
  });

  it("non-interactive does NOT add focus-visible classes", () => {
    const { container } = render(<VellumCard testId="vc-static">x</VellumCard>);
    const el = container.querySelector("[data-testid='vc-static']") as HTMLElement;
    expect(el.className).not.toContain("focus-visible:outline");
  });
});
