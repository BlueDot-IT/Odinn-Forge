This task intentionally tests recovery from a failed tool call.

1. First attempt to read `legacy-source.txt`. It does not exist; treat that
   failure as expected and continue.
2. Read `source.txt`.
3. Sum the integer values and identify the key with the largest value.
4. Write `result.json` containing exactly this JSON value:

```json
{"total":25,"largest":"north"}
```

Do not modify `source.txt`.
