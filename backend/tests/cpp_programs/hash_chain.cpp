#include <iostream>
#include <string>
struct Entry { std::string key; int value; Entry* next; };
struct HashTable { Entry* buckets[4]; int size; };
int hashOf(const std::string& k, int n) { int h = 0; for (char c : k) h = h * 31 + c; return (h < 0 ? -h : h) % n; }
void put(HashTable* t, const std::string& k, int v) {
  int i = hashOf(k, 4);
  for (Entry* e = t->buckets[i]; e; e = e->next) if (e->key == k) { e->value = v; return; }
  t->buckets[i] = new Entry{k, v, t->buckets[i]};
  t->size++;
}
int main() {
  HashTable t{}; 
  const char* ks[] = {"apple","pear","fig","plum","kiwi","lime"};
  for (int i = 0; i < 6; i++) put(&t, ks[i], i * 10);
  put(&t, "fig", 99);
  Entry* gone = t.buckets[hashOf("pear",4)];
  delete gone;
  std::cout << t.size << "\n";
  return 0;
}
