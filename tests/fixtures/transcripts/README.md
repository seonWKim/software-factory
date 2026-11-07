Transcript fixtures for tests/ui-transcript*.test.ts(x). `@@PLANTED_SECRET@@` is replaced inside the test with a
secret-shaped string built at run time, so no secret-shaped literal sits in the repository (the commit scan would
flag it). The 10 MB transcript is generated inside the paging test, not checked in.
