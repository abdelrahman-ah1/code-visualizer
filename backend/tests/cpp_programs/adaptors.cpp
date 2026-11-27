#include <queue>
#include <stack>

struct queue {          // a user type that only shares the name: not std::queue
    int front;
};

int main() {
    std::queue<int> q;
    q.push(10);
    q.push(20);
    q.push(30);
    q.pop();            // front to back: 20, 30
    std::stack<int> s;
    s.push(1);
    s.push(2);
    s.push(3);          // bottom to top: 1, 2, 3
    std::priority_queue<int> pq;
    pq.push(5);
    pq.push(1);
    pq.push(9);         // heap order: the top (9) comes first, the rest is storage order
    queue mine{7};      // stays a plain struct with fields
    return 0;
}
