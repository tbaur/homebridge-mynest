"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Shapes returned by the Nest REST API.
 *
 * Every field here was observed on a live account. Fields are optional and
 * loosely typed on purpose: Nest returns different subsets per firmware
 * revision, and a bucket missing a field must degrade to "unknown" rather than
 * throw.
 */
Object.defineProperty(exports, "__esModule", { value: true });
