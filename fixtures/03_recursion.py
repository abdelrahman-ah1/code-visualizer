def factorial(n):
    if n <= 1:
        return 1
    partial = factorial(n - 1)
    return n * partial
answer = factorial(3)
