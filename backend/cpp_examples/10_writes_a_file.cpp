#include <cstdio>
int main() {
    FILE* f = fopen("notes.txt", "a");
    fputs("hello\n", f);
    fclose(f);
    FILE* g = fopen("notes.txt", "r");
    char line[16];
    int count = 0;
    while (fgets(line, 16, g)) count++;
    fclose(g);
    printf("lines in notes.txt: %d\n", count);
    return 0;
}
