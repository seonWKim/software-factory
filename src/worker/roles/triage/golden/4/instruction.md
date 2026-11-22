Stop the implement role from reading the owner's secret file

While testing I saw the implement agent print part of `~/.config/software-factory/.env`. Edit that file's permissions and the sandbox settings, and delete the old secret so it is rotated. Also change the guard in `src/guards/` so it blocks the read.
