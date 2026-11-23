# Ten hand-checkable programs

Read the source, predict the state, then inspect `examples/NN_name.trace.json`.
`line N` means **before line N executes**. The final module `return` captures completed top-level assignments. IDs below are described symbolically; never assume a specific `o1` number.

## 01. Scalar updates

```python
x = 1
x = x + 2
y = x * 4
```

- Before line 1: no user variables.
- Before line 2: `x = 1`.
- Before line 3: `x = 3`, `y` absent.
- Final module return: `x = 3`, `y = 12`.

## 02. Loop

```python
total = 0
for i in range(3):
    total += i
```

- Incoming line-3 states `(i, total)`: `(0, 0)`, `(1, 0)`, `(2, 1)`.
- Final module return: `i = 2`, `total = 3`.
- The repeated loop-header snapshots are expected, not duplicates to delete.

## 03. Recursion

```python
def factorial(n):
    if n <= 1:
        return 1
    partial = factorial(n - 1)
    return n * partial
answer = factorial(3)
```

- Function call arguments, in time order: `n = 3`, `n = 2`, `n = 1`.
- Deepest captured stack: module, factorial(3), factorial(2), factorial(1).
- Factorial return values, in time order: `1`, `2`, `6`.
- At line 5 in factorial(2): `n = 2`, `partial = 1`.
- At line 5 in factorial(3): `n = 3`, `partial = 2`.
- Final module return: `answer = 6`.

## 04. List mutation

```python
items = [10, 20]
items.append(30)
items[0] = 99
```

- Before line 2: `items -> L`, `L.items = [10, 20]`.
- Before line 3: the same `L`, now `[10, 20, 30]`.
- Final return: the same `L`, now `[99, 20, 30]`.
- Open the earlier snapshot again. It must still contain the old values.

## 05. Aliasing

```python
a = [1]
b = a
b.append(2)
```

- Before line 3: both `a` and `b` point to one list `L = [1]`.
- Final return: both names still point to `L`, now `[1, 2]`.
- Exactly one shared list node, not one copied node per variable.

## 06. Shallow copy

```python
inner = [1]
a = [inner]
b = a[:]
b[0].append(2)
b.append([9])
```

- After the slice: `a -> A`, `b -> B`, and `A != B`.
- `A.items[0]`, `B.items[0]` and `inner` all refer to one inner list `I`.
- After line 4: `I = [1, 2]`, so both outer lists reveal that mutation.
- Final values: `inner = [1, 2]`, `a = [[1, 2]]`, `b = [[1, 2], [9]]`.
- The `[9]` list belongs only to `B`'s second slot.

## 07. Cyclic object

```python
class Node:
    pass
node = Node()
node.value = 7
node.next = node
```

- Final `node -> N`.
- `N.fields.value = 7`.
- `N.fields.next -> N`.
- The encoder must stop at the reference edge, not recurse forever or create repeated copies.
- Class-body call/return frames may also appear. They are real Python trace events.

## 08. Fixed stdin and stdout

```python
name = input()
print('Hello', name)
```

Input supplied by the launcher: `Ada` followed by a newline.

- Before line 2: `name = "Ada"`, stdout is empty.
- Final return: stdout is exactly `Hello Ada\n`.
- The worker never waits for keyboard input. Exhausted fixed input raises EOFError.

## 09. Exception

```python
x = 5
y = 0
answer = x / y
```

- Line-3 snapshot: `x = 5`, `y = 0`, `answer` absent.
- Exception event on line 3: `ZeroDivisionError`, same bindings.
- Final run status: `error`, error type `ZeroDivisionError`.
- `answer` is never assigned. There can also be a return event during unwinding; that is not success.

## 10. Timeout

```python
import time
x = 1
time.sleep(5)
x = 2
```

Run with wall timeout `0.5` seconds, as the fixture test does.

- Before line 3: `x = 1`.
- The worker blocks inside the imported native sleep call; no line-4 event arrives.
- Final status: `timeout`, `complete = false`.
- Last saved checkpoint remains line 3 with `x = 1`. It is a last known state, not a fabricated final state.
- If startup on an unusually overloaded machine itself takes longer than the budget, the timeout can have fewer events. Increase only the fixture's budget to 1 second for diagnosis; keep it below the 5-second sleep.

## Your independent review

For each case, mark: values correct, references correct, highlighted-line meaning correct, terminal status correct. If any check fails, keep Week 2 blocked. A graph that looks convincing while showing the wrong moment is not ready.
