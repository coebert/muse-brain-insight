import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { getMyRole } from "@/lib/roles.functions";

/** True when the signed-in account holds the admin role. */
export function useIsAdmin() {
  const fetchRole = useServerFn(getMyRole);
  const { data, isPending } = useQuery({
    queryKey: ["my-role"],
    queryFn: () => fetchRole(),
    staleTime: 5 * 60_000,
  });
  return { isAdmin: data?.role === "admin", loading: isPending };
}
