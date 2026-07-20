import type { Metadata } from "next";
import "../atlas.css";
import "./benchmark.css";

import { BenchmarkLab } from "../components/BenchmarkLab";

export const metadata: Metadata = {
  title: "Benchmark Lab",
  description:
    "Measure Local Code Atlas analyzer precision, recall, and F1 against bundled deterministic fixtures.",
};

export default function BenchmarkPage() {
  return <BenchmarkLab />;
}
