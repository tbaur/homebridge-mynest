/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Human-readable formatting for diagnostics reports.
 */
import type { DiagnosticsSnapshot } from './types';
/** Concise human-readable summary line for a diagnostics report. */
export declare function formatDiagnosticLine(report: DiagnosticsSnapshot): string;
