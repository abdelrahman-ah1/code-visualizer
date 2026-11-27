#include <iostream>
#include <queue>

int main() {
    std::queue<int> q;
    for (int i = 1; i <= 5; i++) {
        q.push(i * 10);
    }
    int total = 0;
    while (!q.empty()) {
        total += q.front();
        q.pop();
    }

    std::priority_queue<int> pq;
    pq.push(40);
    pq.push(10);
    pq.push(30);
    pq.push(20);
    int last = 0;
    while (!pq.empty()) {
        last = pq.top();
        pq.pop();
    }
    std::cout << total << " " << last << std::endl;
    return 0;
}
