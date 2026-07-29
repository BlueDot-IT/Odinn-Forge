Return exactly one JSON object with no Markdown or commentary.

Given the values `[7, 2, 9, 2]`:

1. Sort them in ascending order.
2. Compute `checksum` as the sum of each sorted value multiplied by its
   one-based position.

The object must have exactly these keys in this order:

- `status`, with value `"ok"`
- `ordered`, with the sorted array
- `checksum`, with the computed integer
