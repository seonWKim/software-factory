import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { API, type UserRow, type UsersView, type UsersWrite, postUsers, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Badge, Empty, ErrorNote, Loading, Section, Table, Td, Tr } from "../components/ui/parts.js";

// The Users page (design 08-permissions and 09-dashboard-app, issue #445): who you are on this page (the identity
// the UI process started with and where it came from, and your role), then every local user, every user the
// `static` grant names and their linked accounts. The owner adds, changes and removes local users here, each write
// a POST /api/v1/users with the CSRF token through the CLI's own `users` actions; anyone else sees the list
// read-only with the reason. The owner's row has no controls. A table at sm and up, cards below.

const muted = "text-xs text-pretty text-zinc-600 dark:text-zinc-400";
const field = "h-8 rounded-md border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900";
const ROLES = ["approver", "requester"] as const;

/** One write and its refusal, kept beside where it was made until the next try. */
function useUsersWrite(token: string) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const write = async (body: UsersWrite): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const r = await postUsers(token, body);
      if (!r.ok) {
        setError(r.error);
        return false;
      }
      await client.invalidateQueries({ queryKey: [API.users] });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, write };
}

function Refusal({ error }: { error: string | null }) {
  return error ? <p role="alert" className="mt-1 text-xs text-pretty break-words text-red-700 dark:text-red-300">{error}</p> : null;
}

/** Change and Remove for one local user that is not the owner. */
function RowControls({ user, token }: { user: UserRow; token: string }) {
  const { busy, error, write } = useUsersWrite(token);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={`Role of ${user.user_id}`}
          className={field}
          value={user.role}
          disabled={busy}
          onChange={(e) => void write({ action: "change", user_id: user.user_id, role: e.target.value as (typeof ROLES)[number] })}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <Button variant="outline" className="h-8 w-auto px-2" disabled={busy} onClick={() => void write({ action: "remove", user_id: user.user_id })}>
          Remove
        </Button>
      </div>
      <Refusal error={error} />
    </div>
  );
}

function AddUser({ token }: { token: string }) {
  const { busy, error, write } = useUsersWrite(token);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("requester");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await write({ action: "add", user_id: userId.trim(), role })) setUserId("");
  };
  return (
    <form aria-label="Add a user" className="mt-3" onSubmit={(e) => void submit(e)}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="User ID"
          className={`${field} min-w-0 flex-1`}
          placeholder="local:dev@example.com"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
        />
        <select aria-label="Role" className={field} value={role} onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <Button type="submit" variant="outline" className="h-8 w-auto px-2" disabled={busy || userId.trim() === ""}>
          Add
        </Button>
      </div>
      <p className={`mt-1 ${muted}`}>A factory user ID: local:&lt;name&gt; or &lt;provider&gt;:&lt;id&gt;, never a display name.</p>
      <Refusal error={error} />
    </form>
  );
}

const sourceText = (u: UserRow) =>
  u.source === "local" ? "local" : `static (${u.projects.map((p) => `${p.project}: ${p.roles.join(", ")}`).join("; ")})`;

export function UsersPage() {
  const users = useApi<UsersView>(API.users);
  const v = users.data;
  if (users.isError) return <ErrorNote error={users.error} />;
  if (!v) return <Loading rows={3} />;
  const head = ["User", "Role", "Source", "Added by", "Added at", "Links", ...(v.can_change ? ["Change"] : [])];
  return (
    <>
      <Section title="You">
        <p className="text-sm text-pretty break-words" data-testid="viewer">
          <span className="font-mono">{v.viewer.user_id}</span> (from {v.viewer.source}) · role {v.viewer.role ?? "none"}
        </p>
        <p className={`mt-1 ${muted}`}>The identity this page started with, as `factory users list` shows it. Users writes act as it.</p>
      </Section>
      <Section title="Users" count={v.users.length}>
        {v.read_only_reason !== null && (
          <p role="note" className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-pretty break-words text-amber-900 dark:bg-amber-950 dark:text-amber-100">
            Read-only: {v.read_only_reason}.
          </p>
        )}
        {v.users.length === 0 ? (
          <Empty>No local users yet: the first identity to change a role, or to run a writing command, becomes the owner.</Empty>
        ) : (
          <Table label="Users" head={head}>
            {v.users.map((u) => (
              <Tr key={`${u.source}:${u.user_id}`} data-user={u.user_id} data-source={u.source}>
                <Td className="font-mono break-all">{u.user_id}</Td>
                <Td>
                  <Badge>{u.role}</Badge>
                </Td>
                <Td>{sourceText(u)}</Td>
                <Td>{u.added_by ?? "-"}</Td>
                <Td className="tabular-nums">{u.added_at ?? "-"}</Td>
                <Td>{u.links.length === 0 ? "none" : u.links.map((l) => `${l.provider}:${l.subject}`).join(", ")}</Td>
                {v.can_change && <Td>{u.source === "local" && u.role !== "owner" ? <RowControls user={u} token={v.csrf_token} /> : null}</Td>}
              </Tr>
            ))}
          </Table>
        )}
        {v.can_change && <AddUser token={v.csrf_token} />}
        <p className={`mt-3 ${muted}`}>
          Roles from GitHub permission are not listed: this page makes no GitHub call. Static grants change in factory.config.json
          (permissions.static); accounts link with `factory link-code`.
        </p>
      </Section>
    </>
  );
}
