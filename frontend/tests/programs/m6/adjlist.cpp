#include <iostream>
#include <vector>
#include <queue>

int main() {
    int n = 5;
    std::vector<std::vector<int>> adj(n);
    adj[0] = {1, 2};
    adj[1] = {3};
    adj[2] = {3, 4};
    adj[3] = {4};

    std::vector<bool> seen(n, false);
    std::queue<int> q;
    q.push(0);
    seen[0] = true;
    int order = 0;

    while (!q.empty()) {
        int u = q.front();
        q.pop();
        order++;
        for (int v : adj[u]) {
            if (!seen[v]) {
                seen[v] = true;
                q.push(v);
            }
        }
    }
    std::cout << order << std::endl;
    return 0;
}
