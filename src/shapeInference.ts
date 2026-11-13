import type { CodeContext } from './types.js';

export interface StaticShapeFact {
  filePath: string;
  line: number;
  variable?: string;
  operation: string;
  constraint: string;
  inputShape?: string;
  outputShape?: string;
  certainty: 'exact' | 'symbolic' | 'partial';
}

interface LayerSpec {
  kind: string;
  args: string[];
}

function splitArguments(value: string): string[] {
  const result: string[] = [];
  let current = '';
  let depth = 0;
  let quote = '';
  for (const character of value) {
    if (quote) {
      current += character;
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if ('([{'.includes(character)) depth += 1;
    if (')]}'.includes(character)) depth -= 1;
    if (character === ',' && depth === 0) {
      if (current.trim()) result.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function shapeText(shape?: string[]): string | undefined {
  return shape ? `[${shape.join(', ')}]` : undefined;
}

function numericAxis(value: string, rank: number): number | undefined {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed)) return undefined;
  const axis = parsed < 0 ? rank + parsed : parsed;
  return axis >= 0 && axis < rank ? axis : undefined;
}

function variableFromExpression(expression: string): string | undefined {
  return expression.trim().match(/^([A-Za-z_]\w*)/)?.[1];
}

function certainty(shape?: string[]): StaticShapeFact['certainty'] {
  if (!shape) return 'partial';
  return shape.every((dimension) => /^\d+$/.test(dimension)) ? 'exact' : 'symbolic';
}

function inferEinsumShape(equation: string, operands: string[], shapes: Map<string, string[]>): string[] | undefined {
  const [rawInputs, rawOutput] = equation.replace(/\s+/g, '').split('->');
  if (!rawInputs || !rawOutput || rawInputs.includes('...') || rawOutput.includes('...')) return undefined;
  const inputTerms = rawInputs.split(',');
  if (inputTerms.length !== operands.length) return undefined;
  const dimensions = new Map<string, string>();
  for (let index = 0; index < inputTerms.length; index += 1) {
    const term = inputTerms[index] ?? '';
    const shape = shapes.get(operands[index] ?? '');
    if (!shape || term.length !== shape.length) return undefined;
    for (let axis = 0; axis < term.length; axis += 1) {
      const label = term[axis] ?? '';
      const dimension = shape[axis] ?? '?';
      const previous = dimensions.get(label);
      if (previous && previous !== dimension) dimensions.set(label, `${previous}=${dimension}?`);
      else dimensions.set(label, dimension);
    }
  }
  return [...rawOutput].map((label) => dimensions.get(label) ?? `dim(${label})`);
}

function inferMatmulShape(left?: string[], right?: string[]): string[] | undefined {
  if (!left || !right || left.length < 1 || right.length < 1) return undefined;
  if (left.length === 1 && right.length === 1) return [];
  if (left.length === 1) return [...right.slice(0, -2), right.at(-1)!];
  if (right.length === 1) return [...left.slice(0, -2), left.at(-2)!];
  const leading = left.length >= right.length ? left.slice(0, -2) : right.slice(0, -2);
  return [...leading, left.at(-2)!, right.at(-1)!];
}

function addFact(
  facts: StaticShapeFact[], filePath: string, line: number, variable: string | undefined,
  operation: string, constraint: string, input?: string[], output?: string[]
): void {
  facts.push({ filePath, line, variable, operation, constraint, inputShape: shapeText(input), outputShape: shapeText(output), certainty: certainty(output) });
}

/** Conservative symbolic propagation for common PyTorch/NumPy/einops operations. */
export function inferStaticShapeFacts(contexts: CodeContext[], limit = 160): StaticShapeFact[] {
  const facts: StaticShapeFact[] = [];
  const layers = new Map<string, LayerSpec>();

  for (const context of contexts) {
    for (const source of context.text.split(/\r?\n/)) {
      const declaration = source.match(/\b((?:self\.)?[A-Za-z_]\w*)\s*=\s*(?:nn\.)?(Linear|Conv1d|Conv2d|Conv3d|Embedding)\s*\(([^)]*)\)/);
      if (!declaration) continue;
      const spec = { kind: declaration[2] ?? '', args: splitArguments(declaration[3] ?? '') };
      layers.set(declaration[1] ?? '', spec);
      layers.set((declaration[1] ?? '').replace(/^self\./, ''), spec);
    }
  }

  for (const context of contexts) {
    const shapes = new Map<string, string[]>();
    const lines = context.text.split(/\r?\n/);
    for (let offset = 0; offset < lines.length && facts.length < limit; offset += 1) {
      const source = lines[offset] ?? '';
      const line = context.startLine + offset;
      const declaredLayer = source.match(/\b((?:self\.)?[A-Za-z_]\w*)\s*=\s*(?:nn\.)?(Linear|Conv1d|Conv2d|Conv3d|Embedding)\s*\(([^)]*)\)/);
      if (declaredLayer) {
        const args = splitArguments(declaredLayer[3] ?? '');
        addFact(facts, context.filePath, line, declaredLayer[1], declaredLayer[2] ?? 'layer', `declared parameters ${args.join(', ')}`);
      }
      const shapeBinding = source.match(/^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)+)\s*=\s*([A-Za-z_]\w*)\.shape\s*$/);
      if (shapeBinding) {
        const dimensions = splitArguments(shapeBinding[1] ?? '');
        const inputName = shapeBinding[2] ?? '';
        shapes.set(inputName, dimensions);
        addFact(facts, context.filePath, line, inputName, 'shape destructuring', `${inputName}.shape binds ${dimensions.join(', ')}`, dimensions, dimensions);
        continue;
      }

      const assignment = source.match(/^\s*([A-Za-z_]\w*)\s*=\s*(.+)$/);
      const variable = assignment?.[1];
      const expression = assignment?.[2] ?? source;
      const sourceVariable = variableFromExpression(expression);
      const input = sourceVariable ? shapes.get(sourceVariable) : undefined;
      let output: string[] | undefined;

      const constructed = expression.match(/(?:torch\.)?(?:zeros|ones|empty|rand|randn|full)\s*\(([^)]*)\)/);
      if (constructed) {
        output = splitArguments(constructed[1] ?? '').filter((argument) => !/^(?:dtype|device|requires_grad)\s*=/.test(argument));
        addFact(facts, context.filePath, line, variable, 'tensor construction', `declared shape ${shapeText(output)}`, undefined, output);
      }

      const reshape = expression.match(/\.\s*(?:view|reshape)\s*\(([^)]*)\)/);
      if (reshape) {
        output = splitArguments(reshape[1] ?? '');
        addFact(facts, context.filePath, line, variable, 'reshape', `target shape ${shapeText(output)}; -1 is inferred from conserved element count`, input, output);
      }
      const permute = expression.match(/\.\s*permute\s*\(([^)]*)\)/);
      if (permute) {
        const axes = splitArguments(permute[1] ?? '');
        const numeric = input && axes.map((axis) => numericAxis(axis, input.length));
        output = input && numeric?.every((axis) => axis !== undefined)
          ? numeric.map((axis) => input[axis!]!)
          : axes.map((axis) => `dim(${axis})`);
        addFact(facts, context.filePath, line, variable, 'permute', `axis order ${shapeText(axes)}`, input, output);
      }
      const transpose = expression.match(/\.\s*transpose\s*\(([^,]+),\s*([^)]+)\)/);
      if (transpose) {
        output = input ? [...input] : undefined;
        const left = output ? numericAxis(transpose[1] ?? '', output.length) : undefined;
        const right = output ? numericAxis(transpose[2] ?? '', output.length) : undefined;
        if (output && left !== undefined && right !== undefined) [output[left], output[right]] = [output[right]!, output[left]!];
        addFact(facts, context.filePath, line, variable, 'transpose', `swap axes ${transpose[1]?.trim()} and ${transpose[2]?.trim()}`, input, output);
      }
      const unsqueeze = expression.match(/\.\s*unsqueeze\s*\(([^)]+)\)/);
      if (unsqueeze) {
        output = input ? [...input] : undefined;
        if (output) {
          const raw = Number.parseInt(unsqueeze[1] ?? '', 10);
          const axis = raw < 0 ? output.length + raw + 1 : raw;
          if (axis >= 0 && axis <= output.length) output.splice(axis, 0, '1');
        }
        addFact(facts, context.filePath, line, variable, 'unsqueeze', `insert size-1 axis at ${unsqueeze[1]?.trim()}`, input, output);
      }
      const squeeze = expression.match(/\.\s*squeeze\s*\(([^)]*)\)/);
      if (squeeze) {
        output = input ? [...input] : undefined;
        if (output) {
          const requested = squeeze[1]?.trim();
          if (requested) {
            const axis = numericAxis(requested, output.length);
            if (axis !== undefined && output[axis] === '1') output.splice(axis, 1);
          } else output = output.filter((dimension) => dimension !== '1');
        }
        addFact(facts, context.filePath, line, variable, 'squeeze', squeeze[1]?.trim() ? `remove axis ${squeeze[1].trim()} only if it is size 1` : 'remove all size-1 axes', input, output);
      }
      const flatten = expression.match(/\.\s*flatten\s*\(([^)]*)\)/);
      if (flatten) {
        const args = splitArguments(flatten[1] ?? '');
        output = input ? [...input] : undefined;
        if (output) {
          const start = numericAxis(args[0] ?? '0', output.length) ?? 0;
          const end = numericAxis(args[1] ?? '-1', output.length) ?? output.length - 1;
          output.splice(start, end - start + 1, output.slice(start, end + 1).join('*'));
        }
        addFact(facts, context.filePath, line, variable, 'flatten', `multiply axes ${args[0] ?? '0'} through ${args[1] ?? '-1'}`, input, output);
      }

      const rearrange = expression.match(/rearrange\s*\([^,]+,\s*['"]([^'"]+)['"]/);
      if (rearrange) {
        const equation = rearrange[1] ?? '';
        const right = equation.split('->')[1]?.trim();
        output = right ? right.split(/\s+/).filter(Boolean) : undefined;
        addFact(facts, context.filePath, line, variable, 'einops.rearrange', equation, input, output);
      }

      const cat = expression.match(/(?:torch\.)?(cat|stack)\s*\(\s*\[([^\]]+)]\s*,?\s*(?:dim\s*=\s*)?([^,)]+)?/);
      if (cat) {
        const inputs = splitArguments(cat[2] ?? '').map((name) => shapes.get(name.trim())).filter((shape): shape is string[] => Boolean(shape));
        const base = inputs[0] ? [...inputs[0]] : undefined;
        const axis = base ? numericAxis(cat[3] ?? '0', base.length + (cat[1] === 'stack' ? 1 : 0)) : undefined;
        output = base;
        if (output && axis !== undefined) {
          if (cat[1] === 'stack') output.splice(axis, 0, String(inputs.length || 'N'));
          else output[axis] = inputs.map((shape) => shape[axis] ?? '?').join('+');
        }
        addFact(facts, context.filePath, line, variable, cat[1] ?? 'cat', `${cat[1] === 'stack' ? 'insert' : 'sum'} axis ${cat[3]?.trim() ?? '0'}`, inputs[0], output);
      }

      const reduce = expression.match(/\.\s*(mean|sum|max|min)\s*\([^)]*?(?:dim|axis)\s*=\s*([^,)]+)(?:[^)]*?keepdim\s*=\s*(True|False|true|false))?/);
      if (reduce) {
        output = input ? [...input] : undefined;
        const axes = (reduce[2] ?? '').replace(/[()[\]]/g, '').split(',').map((part) => part.trim());
        const keep = /^true$/i.test(reduce[3] ?? 'false');
        if (output) {
          const indexes = axes.map((axis) => numericAxis(axis, output!.length)).filter((axis): axis is number => axis !== undefined).sort((a, b) => b - a);
          for (const axis of indexes) keep ? output.splice(axis, 1, '1') : output.splice(axis, 1);
        }
        addFact(facts, context.filePath, line, variable, reduce[1] ?? 'reduce', `reduce axes ${axes.join(', ')}; keepdim=${keep}`, input, output);
      }

      const expand = expression.match(/\.\s*(repeat|expand)\s*\(([^)]*)\)/);
      if (expand) {
        const args = splitArguments(expand[2] ?? '');
        output = expand[1] === 'expand'
          ? args.map((dimension, index) => dimension === '-1' ? input?.[index] ?? '-1' : dimension)
          : input && args.length === input.length
            ? input.map((dimension, index) => `${dimension}*${args[index]}`)
            : undefined;
        addFact(facts, context.filePath, line, variable, expand[1] ?? 'expand', `${expand[1] === 'repeat' ? 'repeat factors' : 'broadcast target'} ${shapeText(args)}`, input, output);
      }

      const interpolate = expression.match(/(?:F\.|torch\.nn\.functional\.)?interpolate\s*\([^)]*(?:size\s*=\s*([^,)]+)|scale_factor\s*=\s*([^,)]+))/);
      if (interpolate) {
        output = input ? [...input] : undefined;
        if (output && interpolate[1]) {
          const spatial = interpolate[1].replace(/[()[\]]/g, '').split(/\s*,\s*/).filter(Boolean);
          output.splice(Math.max(0, output.length - spatial.length), spatial.length, ...spatial);
        }
        addFact(facts, context.filePath, line, variable, 'interpolate', interpolate[1] ? `target spatial size ${interpolate[1].trim()}` : `spatial scale factor ${interpolate[2]?.trim()}`, input, output);
      }

      const layerCall = expression.match(/^((?:self\.)?[A-Za-z_]\w*)\s*\(\s*([A-Za-z_]\w*)/);
      const spec = layerCall ? layers.get(layerCall[1] ?? '') : undefined;
      const layerInput = layerCall ? shapes.get(layerCall[2] ?? '') : undefined;
      if (spec) {
        output = layerInput ? [...layerInput] : undefined;
        if (output && spec.kind === 'Linear' && spec.args[1]) output[output.length - 1] = spec.args[1];
        if (output && /^Conv[123]d$/.test(spec.kind) && spec.args[1] && output.length >= 2) {
          output[1] = spec.args[1];
          const spatialRank = Number.parseInt(spec.kind[4] ?? '0', 10);
          const kernel = spec.args[2] ?? 'k';
          const stride = spec.args.find((arg) => /^stride\s*=/.test(arg))?.split('=')[1] ?? '1';
          const padding = spec.args.find((arg) => /^padding\s*=/.test(arg))?.split('=')[1] ?? '0';
          for (let index = output.length - spatialRank; index < output.length; index += 1) {
            output[index] = `floor((${layerInput?.[index] ?? '?'}+2*${padding}-${kernel})/${stride})+1`;
          }
        }
        if (output && spec.kind === 'Embedding' && spec.args[1]) output.push(spec.args[1]);
        addFact(facts, context.filePath, line, variable, spec.kind, `apply ${layerCall?.[1]} with parameters ${spec.args.join(', ')}`, layerInput, output);
      }

      const einsum = expression.match(/einsum\s*\(\s*['"]([^'"]+)['"]\s*,\s*([^)]*)\)/);
      if (einsum) {
        const operands = splitArguments(einsum[2] ?? '').map((operand) => operand.trim());
        output = inferEinsumShape(einsum[1] ?? '', operands, shapes);
        addFact(facts, context.filePath, line, variable, 'einsum', `axis equation ${einsum[1]}`, shapes.get(operands[0] ?? ''), output);
      }
      const matmul = expression.match(/(?:torch\.)?(?:matmul|bmm)\s*\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)|([A-Za-z_]\w*)\s*@\s*([A-Za-z_]\w*)/);
      if (matmul) {
        const leftName = matmul[1] ?? matmul[3] ?? '';
        const rightName = matmul[2] ?? matmul[4] ?? '';
        const leftShape = shapes.get(leftName);
        output = inferMatmulShape(leftShape, shapes.get(rightName));
        addFact(facts, context.filePath, line, variable, 'matrix multiplication', `contract ${leftName}'s last axis with ${rightName}'s second-to-last axis and broadcast leading axes`, leftShape, output);
      }
      const preserving = expression.match(/^([A-Za-z_]\w*)\.(?:softmax|sigmoid|relu|gelu|contiguous|clone|detach|to|float|half)\s*\(/);
      if (preserving && !output) {
        output = shapes.get(preserving[1] ?? '');
        addFact(facts, context.filePath, line, variable, 'shape-preserving operation', `${preserving[1]} keeps its tensor rank and dimensions`, output, output);
      }
      if (variable && output) shapes.set(variable, output);
    }
    if (facts.length >= limit) break;
  }
  return facts.slice(0, limit);
}

export function staticShapeContext(contexts: CodeContext[]): string {
  const facts = inferStaticShapeFacts(contexts);
  if (!facts.length) return '(No deterministic static shape operations were found in the supplied ranges.)';
  return facts.map((fact) => {
    const transition = fact.inputShape || fact.outputShape ? `; ${fact.inputShape ?? '?'} -> ${fact.outputShape ?? '?'}` : '';
    return `${fact.filePath}:${fact.line} ${fact.variable ? `${fact.variable}: ` : ''}${fact.operation} — ${fact.constraint}${transition} [${fact.certainty}]`;
  }).join('\n');
}
