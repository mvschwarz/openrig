#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
  .name("rigged")
  .description("CLI for the Rigged local control plane")
  .version("0.1.0");

program.parse();
